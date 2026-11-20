#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { getFirebase } = require('../server/firebase.cjs');
const { ownsPhotoKey } = require('../server/storage.cjs');
const { assertProject, createStorageReader, verifyObject } = require('./verify-photo-migration.cjs');

const PROJECT = 'my-plants-app-8f6fc';
// No CLI/env override. Lift only after a separately verified application release.
const APPLICATION_COMPATIBILITY = Object.freeze({
  localPreviewCompatible: true,
  productionVerified: false,
  applyAllowed: false,
  code: 'PRODUCTION_PREVIEW_FIX_NOT_VERIFIED',
  lastInspectedProductionBundle: 'main.ec36d3ac.js',
});
const HELP = `Legacy base64 cleanup for ${PROJECT} (Node.js 24).
  npm.cmd run cleanup:photos -- --project ${PROJECT} --dry-run
  npm.cmd run cleanup:photos -- --project ${PROJECT} --apply --limit 5 --stop-on-error
  npm.cmd run cleanup:photos -- --project ${PROJECT} --apply --stop-on-error
Default: dry-run. All owners and wishlist; trash/deletion locks are always skipped.
Only photo may be removed, using Admin FieldValue.delete() inside a transaction.
Every attempted candidate first passes owner/path checks and full S3 HEAD/GET/WebP validation.
--limit bounds candidate attempts (including errors), never exceeds that many deletions.
After the limit, scanning continues for counts, without further S3 checks or writes.
--stop-on-error stops immediately and marks the report incomplete.
S3 is read-only: no uploads, deletes, listing or signed URLs.
Local wishlist preview supports photoKey; the fixed production release is not yet verified.
APPLY IS CURRENTLY BLOCKED until the preview fix is deployed and checked separately.
Dry-run does not establish application compatibility. No flag/env can bypass this block.`;

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
    || Object.keys(options).some((key) => !['project', 'apply', 'stopOnError', 'limit'].includes(key))) {
    throw new CleanupError('INVALID_OPTIONS_OR_PROJECT');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new CleanupError('INVALID_LIMIT');
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
    else if (flag === '--stop-on-error') options.stopOnError = true;
    else if (flag === '--dry-run') { /* Explicit spelling of the default. */ }
    else if (['--project', '--limit'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new CleanupError('OPTION_VALUE_REQUIRED');
      if (flag === '--project') options.project = value;
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

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const safeId = (id) => validId(id) ? id
  : `invalid-id-sha256:${createHash('sha256').update(String(id)).digest('hex')}`;

function skipReason(data) {
  if (data.deletedAt) return 'trash';
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

async function cleanupPlant({ db, snapshot, apply = false, connection, onVerified = () => {} }) {
  const id = snapshot?.id;
  assertSnapshot(snapshot, id);
  const data = snapshot.data();
  const reason = skipReason(data);
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
        || skipReason(current)) throw new CleanupError('PLANT_CHANGED');
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
    skippedByReason: {}, errorsByCode: {}, stopped: false, scanComplete: false,
    compatibilityPassed,
    localPreviewCompatible: compatibility.localPreviewCompatible === true,
    productionVerified: compatibility.productionVerified === true,
    applicationBlock: compatibilityPassed ? null : APPLICATION_COMPATIBILITY.code,
    readyToApply: false, issues: [] };
  try {
    for await (const snapshot of plantSnapshots(db)) {
      report.checked += 1;
      const plantId = safeId(snapshot.id);
      try {
        if (!snapshot.exists) throw new CleanupError('PLANT_NOT_FOUND');
        const data = snapshot.data();
        const reason = skipReason(data);
        if (reason) {
          report.skipped += 1;
          report.skippedByReason[reason] = (report.skippedByReason[reason] || 0) + 1;
          onResult({ plantId, status: 'skipped', reason });
          continue;
        }
        report.candidates += 1;
        if (data.isWishlisted) report.wishlistCandidates += 1;
        if (report.attempted >= (options.limit ?? Infinity)) { report.deferred += 1; continue; }
        report.attempted += 1;
        const result = await cleanupPlant({ db, snapshot, apply: options.apply, connection,
          onVerified: ({ estimatedBytes }) => {
            report.eligible += 1;
            if (data.isWishlisted) report.wishlistEligible += 1;
            report.verifiedObjects += 1;
            report.estimatedReclaimableBytes += estimatedBytes;
          } });
        if (result.status === 'removed') {
          report.removed += 1;
          if (data.isWishlisted) report.wishlistRemoved += 1;
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
  assertCompatibility(options); // Block unsafe apply BEFORE SDK initialization/cloud access.
  const connection = createStorageReader(process.env); // Only HEAD/GET used, in both modes.
  let firebase;
  try {
    firebase = getFirebase();
    assertProject(PROJECT, process.env, firebase);
    const report = await runCleanup({ db: firebase.db, options, connection,
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
    const code = error instanceof CleanupError || CONFIG_CODES.has(error?.code)
      ? error.code : 'INITIALIZATION_OR_SHUTDOWN_FAILED';
    console.error('Photo cleanup stopped:', code);
    if (code === 'CLEANUP_BLOCKED_APP_COMPATIBILITY') console.error('The wishlist preview fix must be deployed and verified separately. See docs/base64-photo-cleanup.md. No writes made.');
    process.exitCode = 1;
  });
}

module.exports = { PROJECT, APPLICATION_COMPATIBILITY, parseArgs, assertCompatibility,
  skipReason, approximatePhotoFieldBytes, cleanupPlant, runCleanup, reportExitCode };
