#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { getFirebase } = require('../server/firebase.cjs');
const { ownsPhotoKey } = require('../server/storage.cjs');
const { assertProject, createStorageReader, verifyObject } = require('./verify-photo-migration.cjs');
const { ConfirmationError, loadConfirmation } = require('./photo-cleanup-production-confirmation.cjs');

const PROJECT = 'my-plants-app-8f6fc';
// Default remains blocked. A scoped, current operator attestation is required;
// apply must additionally acknowledge the exact file SHA-256, never a boolean flag.
const APPLICATION_COMPATIBILITY = Object.freeze({
  localPreviewCompatible: true,
  productionVerified: false,
  applyAllowed: false,
  code: 'PRODUCTION_CONFIRMATION_REQUIRED',
  lastInspectedProductionBundle: 'main.ec36d3ac.js',
});
const HELP = `Legacy base64 cleanup for ${PROJECT} (Node.js 24).
  npm.cmd run cleanup:photos -- --project ${PROJECT} --dry-run
    [--production-confirmation PATH]
  npm.cmd run cleanup:photos -- --project ${PROJECT} --apply --limit 5 --stop-on-error
    --production-confirmation PATH --confirm-production SHA256
Default: dry-run. All owners and wishlist; --include-trash also processes trash.
Deletion locks are always skipped. Trash is preserved unless --include-trash is explicit.
Only photo may be removed, using Admin FieldValue.delete() inside a transaction.
Every attempted candidate first passes owner/path checks and full S3 HEAD/GET/WebP validation.
--limit bounds candidate attempts (including errors), never exceeds that many deletions.
After the limit, scanning continues for counts, without further S3 checks or writes.
--stop-on-error stops immediately and marks the report incomplete.
S3 is read-only: no uploads, deletes, listing or signed URLs.
Production confirmation must identify the Deployment, Source SHA and required preview fix,
with every manual check true and a confirmation time within 24 hours.
Apply requires the exact reviewed file SHA-256. No boolean/env override is supported.
This records operator verification, not an independent Vercel API check.
Neither production confirmation nor a prior dry-run replaces per-object/transaction checks.`;

class CleanupError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const STORAGE_CODES = new Set(['OBJECT_MISSING', 'OBJECT_ACCESS_DENIED', 'OBJECT_CHANGED',
  'OBJECT_READ_FAILED', 'OBJECT_READ_TIMEOUT', 'INVALID_OBJECT_SIZE', 'INVALID_CONTENT_TYPE',
  'MISSING_ETAG', 'OBJECT_SIZE_MISMATCH', 'CHECKSUM_MISMATCH', 'INVALID_WEBP']);
const CONFIG_CODES = new Set(['PROJECT_MISMATCH', 'EMULATOR_NOT_SUPPORTED', 'STORAGE_NOT_CONFIGURED',
  'UNEXPECTED_STORAGE_ENDPOINT']);

function validateOptions(options) {
  if (!options || options.project !== PROJECT || typeof options.apply !== 'boolean'
    || typeof options.stopOnError !== 'boolean'
    || Object.keys(options).some((key) => !['project', 'apply', 'stopOnError', 'limit',
      'productionConfirmation', 'confirmProduction', 'includeTrash'].includes(key))
    || (options.includeTrash !== undefined && typeof options.includeTrash !== 'boolean')) {
    throw new CleanupError('INVALID_OPTIONS_OR_PROJECT');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new CleanupError('INVALID_LIMIT');
  }
  if (options.productionConfirmation !== undefined
    && (typeof options.productionConfirmation !== 'string' || !options.productionConfirmation.trim())) {
    throw new CleanupError('INVALID_PRODUCTION_CONFIRMATION_PATH');
  }
  if (options.confirmProduction !== undefined && (typeof options.confirmProduction !== 'string'
    || !/^[a-f0-9]{64}$/i.test(options.confirmProduction) || !options.productionConfirmation)) {
    throw new CleanupError('INVALID_PRODUCTION_CONFIRMATION_ACK');
  }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { apply: false, stopOnError: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new CleanupError('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--include-trash') options.includeTrash = true;
    else if (flag === '--stop-on-error') options.stopOnError = true;
    else if (flag === '--dry-run') { /* Explicit spelling of the default. */ }
    else if (['--project', '--limit', '--production-confirmation', '--confirm-production'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new CleanupError('OPTION_VALUE_REQUIRED');
      if (flag === '--project') options.project = value;
      else if (flag === '--production-confirmation') options.productionConfirmation = value;
      else if (flag === '--confirm-production') options.confirmProduction = value.toLowerCase();
      else {
        if (!/^[1-9][0-9]*$/.test(value)) throw new CleanupError('INVALID_LIMIT');
        options.limit = Number(value);
      }
    } else throw new CleanupError('UNKNOWN_OPTION_USE_HELP');
  }
  if (seen.has('--apply') && seen.has('--dry-run')) throw new CleanupError('CONFLICTING_MODES');
  validateOptions(options);
  return options;
}

function assertCompatibility(options, compatibility = APPLICATION_COMPATIBILITY) {
  if (options.apply && (compatibility.applyAllowed !== true
    || compatibility.localPreviewCompatible !== true || compatibility.productionVerified !== true)) {
    throw new CleanupError('CLEANUP_BLOCKED_APP_COMPATIBILITY');
  }
}

async function resolveCompatibility(options, validationOptions) {
  validateOptions(options);
  if (!options.productionConfirmation) {
    if (options.apply) throw new CleanupError('PRODUCTION_CONFIRMATION_REQUIRED');
    return APPLICATION_COMPATIBILITY;
  }
  const confirmation = await loadConfirmation(options.productionConfirmation, validationOptions);
  if (options.apply && !options.confirmProduction) throw new CleanupError('PRODUCTION_CONFIRMATION_ACK_REQUIRED');
  if (options.confirmProduction && options.confirmProduction.toLowerCase() !== confirmation.sha256) {
    throw new CleanupError('PRODUCTION_CONFIRMATION_HASH_MISMATCH');
  }
  return Object.freeze({ localPreviewCompatible: true, productionVerified: true, applyAllowed: true,
    code: null, confirmation });
}

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const safeId = (id) => validId(id) ? id
  : `invalid-id-sha256:${createHash('sha256').update(String(id)).digest('hex')}`;

function skipReason(data, { includeTrash = false } = {}) {
  if (data.deletedAt && !includeTrash) return 'trash';
  if (data._photoDeleting) return 'photo-deleting';
  if (!Object.hasOwn(data, 'photoKey') || data.photoKey === null) return 'no-photo-key';
  if (typeof data.photo !== 'string' || !/^data:image\/[^;,]+;base64,/.test(data.photo)) return 'no-base64';
  return null;
}

function assertSnapshot(snapshot, id) {
  if (!validId(id) || snapshot?.id !== id || snapshot.ref?.id !== id || snapshot.ref?.path !== `plants/${id}`) {
    throw new CleanupError('INVALID_DOCUMENT_SCOPE');
  }
  if (!snapshot.exists) throw new CleanupError('PLANT_NOT_FOUND');
}

function assertOwnerAndPath(id, data) {
  if (typeof data.userId !== 'string' || !data.userId.trim() || data.userId.length > 128) {
    throw new CleanupError('INVALID_OWNER_UID');
  }
  if (typeof data.photoKey !== 'string' || !data.photoKey) throw new CleanupError('INVALID_PHOTO_KEY');
  if (!ownsPhotoKey(data.userId, id, data.photoKey)) throw new CleanupError('PHOTO_KEY_PATH_MISMATCH');
}

function approximatePhotoFieldBytes(photo) {
  // Firestore string field/value estimate: UTF-8 name + value + terminators.
  // Does not include indexes, backend compression or billing effects.
  return Buffer.byteLength('photo', 'utf8') + Buffer.byteLength(photo, 'utf8') + 2;
}

async function cleanupPlant({ db, snapshot, apply = false, includeTrash = false, connection, onVerified = () => {} }) {
  const id = snapshot?.id;
  assertSnapshot(snapshot, id);
  const data = snapshot.data();
  const reason = skipReason(data, { includeTrash });
  if (reason) return { status: 'skipped', reason };
  assertOwnerAndPath(id, data);
  let verified;
  try { verified = await verifyObject({ ...connection, key: data.photoKey }); }
  catch (error) { throw new CleanupError(STORAGE_CODES.has(error?.code) ? error.code : 'OBJECT_VERIFICATION_FAILED'); }
  const estimatedBytes = approximatePhotoFieldBytes(data.photo);
  onVerified({ estimatedBytes, objectBytes: verified.bytes });
  if (!apply) return { status: 'dry-run', estimatedBytes, objectBytes: verified.bytes };
  try {
    await db.runTransaction(async (tx) => {
      const currentSnapshot = await tx.get(snapshot.ref);
      assertSnapshot(currentSnapshot, id);
      const current = currentSnapshot.data();
      // Check every guard on EVERY transaction retry; unrelated edits remain intact.
      if (current.userId !== data.userId || current.photo !== data.photo || current.photoKey !== data.photoKey
        || current.deletedAt !== data.deletedAt || skipReason(current, { includeTrash })) throw new CleanupError('PLANT_CHANGED');
      assertOwnerAndPath(id, current);
      tx.update(snapshot.ref, { photo: FieldValue.delete() });
    });
  } catch (error) {
    if (error instanceof CleanupError) throw error;
    // A lost commit response may mean deletion committed. Never claim confirmed bytes.
    throw new CleanupError('FIRESTORE_FAILED_OR_OUTCOME_UNKNOWN');
  }
  return { status: 'removed', estimatedBytes, objectBytes: verified.bytes };
}

async function* plantSnapshots(db) {
  let cursor;
  while (true) {
    let query = db.collection('plants').orderBy('__name__').limit(100)
      .select('userId', 'photo', 'photoKey', 'deletedAt', '_photoDeleting', 'isWishlisted');
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const snapshot of page.docs) yield snapshot;
    if (page.size < 100) return;
    cursor = page.docs[page.docs.length - 1];
  }
}

async function runCleanup({ db, options, connection, onResult = () => {},
  compatibility = APPLICATION_COMPATIBILITY }) {
  validateOptions(options);
  // Dependency injection models a future compatible release in IN-MEMORY tests only.
  // The CLI always uses the frozen policy above and exposes no override.
  assertCompatibility(options, compatibility);
  const compatibilityPassed = compatibility.applyAllowed === true
    && compatibility.localPreviewCompatible === true && compatibility.productionVerified === true;
  const report = { mode: options.apply ? 'apply' : 'dry-run', project: PROJECT, scope: 'all-plants-all-owners',
    startedAt: new Date().toISOString(), checked: 0, candidates: 0, eligible: 0, attempted: 0, verifiedObjects: 0,
    dryRunPhotos: 0, removed: 0, skipped: 0, deferred: 0, errors: 0,
    wishlistCandidates: 0, wishlistEligible: 0, wishlistRemoved: 0, estimatedReclaimableBytes: 0, estimatedFreedBytes: 0,
    includeTrash: Boolean(options.includeTrash), trashCandidates: 0, trashEligible: 0, trashRemoved: 0,
    skippedByReason: {}, errorsByCode: {}, stopped: false, scanComplete: false,
    compatibilityPassed,
    localPreviewCompatible: compatibility.localPreviewCompatible === true,
    productionVerified: compatibility.productionVerified === true,
    confirmationValidated: Boolean(compatibility.confirmation),
    productionConfirmation: compatibility.confirmation || null,
    applyRequiresConfirmationHash: true,
    applicationBlock: compatibilityPassed ? null : (compatibility.code || APPLICATION_COMPATIBILITY.code),
    readyToApply: false, issues: [] };
  try {
    for await (const snapshot of plantSnapshots(db)) {
      report.checked += 1;
      const plantId = safeId(snapshot.id);
      try {
        if (!snapshot.exists) throw new CleanupError('PLANT_NOT_FOUND');
        const data = snapshot.data();
        const reason = skipReason(data, options);
        if (reason) {
          report.skipped += 1;
          report.skippedByReason[reason] = (report.skippedByReason[reason] || 0) + 1;
          onResult({ plantId, status: 'skipped', reason });
          continue;
        }
        report.candidates += 1;
        if (data.isWishlisted) report.wishlistCandidates += 1;
        if (data.deletedAt) report.trashCandidates += 1;
        if (report.attempted >= (options.limit ?? Infinity)) { report.deferred += 1; continue; }
        report.attempted += 1;
        const result = await cleanupPlant({ db, snapshot, apply: options.apply, includeTrash: options.includeTrash, connection,
          onVerified: ({ estimatedBytes }) => {
            report.eligible += 1;
            if (data.isWishlisted) report.wishlistEligible += 1;
            if (data.deletedAt) report.trashEligible += 1;
            report.verifiedObjects += 1;
            report.estimatedReclaimableBytes += estimatedBytes;
          } });
        if (result.status === 'removed') {
          report.removed += 1;
          if (data.isWishlisted) report.wishlistRemoved += 1;
          if (data.deletedAt) report.trashRemoved += 1;
          report.estimatedFreedBytes += result.estimatedBytes;
        } else if (result.status === 'dry-run') report.dryRunPhotos += 1;
        onResult({ plantId, ...result }); // Only sanitized cleanupPlant results.
      } catch (error) {
        report.errors += 1;
        const code = error instanceof CleanupError ? error.code : 'PLANT_CHECK_FAILED';
        report.errorsByCode[code] = (report.errorsByCode[code] || 0) + 1;
        const result = { plantId, status: 'error', code };
        report.issues.push(result);
        onResult(result);
        if (options.stopOnError) { report.stopped = true; break; }
      }
    }
    report.scanComplete = !report.stopped;
  } catch {
    report.errors += 1;
    report.errorsByCode.FIRESTORE_SCAN_FAILED = 1;
    report.issues.push({ status: 'error', code: 'FIRESTORE_SCAN_FAILED' });
    report.stopped = true;
  }
  report.readyToApply = report.compatibilityPassed && report.scanComplete && !report.errors && !report.deferred;
  report.completedAt = new Date().toISOString();
  return report;
}

function reportExitCode(report) {
  if (report.errors || !report.scanComplete) return 1;
  return report.compatibilityPassed ? 0 : 2;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  assertProject(PROJECT, process.env);
  const compatibility = await resolveCompatibility(options); // Before SDK initialization/cloud access.
  assertCompatibility(options, compatibility);
  const connection = createStorageReader(process.env); // Only HEAD/GET used, in both modes.
  let firebase;
  try {
    firebase = getFirebase();
    assertProject(PROJECT, process.env, firebase);
    const report = await runCleanup({ db: firebase.db, options, connection, compatibility,
      onResult: (result) => console.log(JSON.stringify(result)) });
    console.log(JSON.stringify({ summary: report }, null, 2));
    process.exitCode = reportExitCode(report);
  } finally {
    connection.client.destroy();
    if (firebase) await firebase.db.terminate();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof CleanupError || error instanceof ConfirmationError || CONFIG_CODES.has(error?.code)
      ? error.code : 'INITIALIZATION_OR_SHUTDOWN_FAILED';
    console.error('Photo cleanup stopped:', code);
    if (code === 'CLEANUP_BLOCKED_APP_COMPATIBILITY') console.error('A valid production confirmation file and its SHA-256 acknowledgement are required. No writes made.');
    process.exitCode = 1;
  });
}

module.exports = { PROJECT, APPLICATION_COMPATIBILITY, parseArgs, assertCompatibility, resolveCompatibility,
  skipReason, approximatePhotoFieldBytes, cleanupPlant, runCleanup, reportExitCode };
