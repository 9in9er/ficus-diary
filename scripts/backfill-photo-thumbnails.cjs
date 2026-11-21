#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getFirebase } = require('../server/firebase.cjs');
const { createPhotoThumbnail, plantPrefix, ownsPhotoKey } = require('../server/storage.cjs');
const { assertProject, createStorageReader, verifyObject } = require('./verify-photo-migration.cjs');

const HELP = `Backfill existing photo thumbnails (Node.js 24; configuration from .env.local).
  npm.cmd run backfill:photo-thumbnails -- --project PROJECT_ID [--dry-run]
  npm.cmd run backfill:photo-thumbnails -- --project PROJECT_ID --apply [--limit 10]
Default: dry-run. Scans all plants, owners, wishlist and trash in pages of 100.
Reads and validates originals; creates <=300px WebP quality 75 in memory.
Only --apply uploads thumbnails and transactionally writes photoThumbKey.
Existing thumbnails and deletion locks are skipped; errors continue by default.
--limit bounds candidate attempts, including errors; --stop-on-error stops on the first error.
Never changes/deletes originals, base64, external URLs, plant documents or rules.
Stable content-based thumbnail keys allow resuming after lost PUT/Firestore responses.
Do not run concurrent backfills or delete plant files during this one-time operation.`;

const STORAGE_CODES = new Set(['OBJECT_MISSING', 'OBJECT_ACCESS_DENIED', 'OBJECT_CHANGED',
  'OBJECT_READ_FAILED', 'OBJECT_READ_TIMEOUT', 'INVALID_OBJECT_SIZE', 'INVALID_CONTENT_TYPE',
  'MISSING_ETAG', 'OBJECT_SIZE_MISMATCH', 'CHECKSUM_MISMATCH', 'INVALID_WEBP']);
const CONFIG_CODES = new Set(['PROJECT_MISMATCH', 'EMULATOR_NOT_SUPPORTED', 'STORAGE_NOT_CONFIGURED',
  'UNEXPECTED_STORAGE_ENDPOINT']);
const PHOTO_FIELDS = ['userId', 'photoKey', 'photoThumbKey', 'deletedAt', '_photoDeleting', 'isWishlisted'];

class ThumbnailError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function validateOptions(options) {
  if (!options || typeof options.project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)
    || typeof options.apply !== 'boolean' || typeof options.stopOnError !== 'boolean'
    || Object.keys(options).some((key) => !['project', 'apply', 'stopOnError', 'limit'].includes(key))) {
    throw new ThumbnailError('INVALID_OPTIONS_USE_HELP');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new ThumbnailError('INVALID_LIMIT');
  }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { apply: false, stopOnError: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new ThumbnailError('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') { /* Default, no cloud writes. */ }
    else if (flag === '--stop-on-error') options.stopOnError = true;
    else if (flag === '--project' || flag === '--limit') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new ThumbnailError('OPTION_VALUE_REQUIRED');
      if (flag === '--project') options.project = value;
      else {
        if (!/^[1-9][0-9]*$/.test(value)) throw new ThumbnailError('INVALID_LIMIT');
        options.limit = Number(value);
      }
    } else throw new ThumbnailError('UNKNOWN_OPTION_USE_HELP');
  }
  if (seen.has('--apply') && seen.has('--dry-run')) throw new ThumbnailError('CONFLICTING_MODES');
  validateOptions(options);
  return options;
}

async function* plantSnapshots(db, fields = PHOTO_FIELDS) {
  let cursor;
  while (true) {
    let query = db.collection('plants').orderBy('__name__').limit(100).select(...fields);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const snapshot of page.docs) yield snapshot;
    if (page.size < 100) return;
    cursor = page.docs[page.docs.length - 1];
  }
}

const hasKey = (data, field) => data[field] !== undefined && data[field] !== null;
function skipReason(data) {
  if (data._photoDeleting) return 'photo-deleting';
  if (hasKey(data, 'photoThumbKey')) return 'has-thumbnail';
  if (!hasKey(data, 'photoKey')) return 'no-photo-key';
  return null;
}

function assertSnapshot(snapshot) {
  const id = snapshot?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
    || snapshot.ref?.id !== id || snapshot.ref?.path !== `plants/${id}`) throw new ThumbnailError('INVALID_DOCUMENT_SCOPE');
  if (!snapshot.exists) throw new ThumbnailError('PLANT_NOT_FOUND');
}

function assertSource(id, data) {
  if (typeof data.userId !== 'string' || !data.userId.trim() || data.userId.length > 128) throw new ThumbnailError('INVALID_OWNER_UID');
  if (!ownsPhotoKey(data.userId, id, data.photoKey)) throw new ThumbnailError('PHOTO_KEY_PATH_MISMATCH');
}

function thumbnailKey(uid, id, photoKey, bytes) {
  const hash = createHash('sha256').update('ficus-thumbnail-backfill-v1\0').update(photoKey).update('\0').update(bytes).digest('hex');
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  return `${plantPrefix(uid, id)}photos/${uuid}.webp`;
}

async function storeThumbnail({ connection, uid, id, photoKey, bytes }) {
  assertSource(id, { userId: uid, photoKey });
  const key = thumbnailKey(uid, id, photoKey, bytes);
  if (key === photoKey) throw new ThumbnailError('THUMBNAIL_KEY_COLLISION');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let head;
  try { head = await connection.client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: key })); }
  catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status ? status !== 404 : !['NotFound', 'NoSuchKey'].includes(error?.name)) throw new ThumbnailError('THUMBNAIL_LOOKUP_FAILED');
  }
  if (head) {
    if (head.ContentLength !== bytes.length || head.ContentType !== 'image/webp' || head.Metadata?.sha256 !== sha256) {
      throw new ThumbnailError('EXISTING_THUMBNAIL_MISMATCH');
    }
    return { photoThumbKey: key, uploadedBytes: 0, reused: true };
  }
  try {
    await connection.client.send(new PutObjectCommand({ Bucket: connection.bucket, Key: key, Body: bytes,
      ContentType: 'image/webp', CacheControl: 'private, max-age=300', Metadata: { sha256 } }));
  } catch { throw new ThumbnailError('THUMBNAIL_UPLOAD_FAILED_OR_OUTCOME_UNKNOWN'); }
  return { photoThumbKey: key, uploadedBytes: bytes.length, reused: false };
}

async function backfillPlant({ db, snapshot, connection, apply = false, onStored = () => {} }) {
  assertSnapshot(snapshot);
  const data = snapshot.data();
  const reason = skipReason(data);
  if (reason) return { status: 'skipped', reason };
  assertSource(snapshot.id, data);
  let original;
  try { original = await verifyObject({ ...connection, key: data.photoKey, includeBuffer: true }); }
  catch (error) { throw new ThumbnailError(STORAGE_CODES.has(error?.code) ? error.code : 'OBJECT_VERIFICATION_FAILED'); }
  let bytes;
  try { bytes = await createPhotoThumbnail(original.buffer); }
  catch { throw new ThumbnailError('THUMBNAIL_CONVERSION_FAILED'); }
  if (!apply) return { status: 'dry-run', thumbnailBytes: bytes.length };
  const stored = await storeThumbnail({ connection, uid: data.userId, id: snapshot.id, photoKey: data.photoKey, bytes });
  onStored(stored);
  try {
    const result = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(snapshot.ref);
      assertSnapshot(fresh);
      const current = fresh.data();
      if (current.userId !== data.userId || current.photoKey !== data.photoKey || current._photoDeleting) {
        throw new ThumbnailError('PLANT_CHANGED');
      }
      assertSource(snapshot.id, current);
      if (hasKey(current, 'photoThumbKey')) return { status: 'skipped', reason: 'has-thumbnail' };
      tx.update(snapshot.ref, { photoThumbKey: stored.photoThumbKey });
      return { status: 'created', thumbnailBytes: bytes.length };
    });
    return result;
  } catch (error) {
    // Never delete on an ambiguous result or source change. Stable keys make
    // retries reuse an orphan thumbnail; permanent plant deletion also covers it.
    if (error instanceof ThumbnailError) throw error;
    throw new ThumbnailError('FIRESTORE_FAILED_OR_OUTCOME_UNKNOWN');
  }
}

function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
    ? id : `invalid-id-sha256:${createHash('sha256').update(String(id)).digest('hex')}`;
}

async function runBackfill({ db, options, connection, onResult = () => {} }) {
  validateOptions(options);
  const report = { mode: options.apply ? 'apply' : 'dry-run', project: options.project, scope: 'all-plants-all-owners',
    checked: 0, candidates: 0, attempted: 0, processed: 0, created: 0, dryRunPhotos: 0, skipped: 0, deferred: 0, errors: 0,
    estimatedThumbnailBytes: 0, uploadedBytes: 0, reusedObjects: 0, skippedByReason: {}, errorsByCode: {},
    scanComplete: false, stopped: false };
  try {
    for await (const snapshot of plantSnapshots(db)) {
      report.checked += 1;
      const plantId = safeId(snapshot.id);
      try {
        assertSnapshot(snapshot);
        const reason = skipReason(snapshot.data());
        if (!reason) {
          report.candidates += 1;
          if (report.attempted >= (options.limit ?? Infinity)) { report.deferred += 1; continue; }
          report.attempted += 1;
        }
        const result = reason ? { status: 'skipped', reason } : await backfillPlant({ db, snapshot, connection,
          apply: options.apply, onStored: (stored) => {
            report.uploadedBytes += stored.uploadedBytes;
            if (stored.reused) report.reusedObjects += 1;
          } });
        if (result.status === 'skipped') {
          report.skipped += 1;
          report.skippedByReason[result.reason] = (report.skippedByReason[result.reason] || 0) + 1;
        } else {
          report.processed += 1;
          if (result.status === 'created') report.created += 1;
          else report.dryRunPhotos += 1;
          report.estimatedThumbnailBytes += result.thumbnailBytes;
        }
        onResult({ plantId, ...result });
      } catch (error) {
        report.errors += 1;
        const code = error instanceof ThumbnailError ? error.code : 'PLANT_CHECK_FAILED';
        report.errorsByCode[code] = (report.errorsByCode[code] || 0) + 1;
        onResult({ plantId, status: 'error', code });
        if (options.stopOnError) { report.stopped = true; break; }
      }
    }
    report.scanComplete = !report.stopped;
  } catch {
    report.errors += 1;
    report.errorsByCode.FIRESTORE_SCAN_FAILED = 1;
    report.stopped = true;
  }
  return report;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  assertProject(options.project, process.env);
  const connection = createStorageReader(process.env);
  let firebase;
  try {
    firebase = getFirebase();
    assertProject(options.project, process.env, firebase);
    const report = await runBackfill({ db: firebase.db, connection, options, onResult: (result) => console.log(JSON.stringify(result)) });
    console.log(JSON.stringify({ summary: report }, null, 2));
    if (report.errors || !report.scanComplete) process.exitCode = 1;
  } finally {
    connection.client.destroy();
    if (firebase) await firebase.db.terminate();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('Thumbnail backfill stopped:', error instanceof ThumbnailError || CONFIG_CODES.has(error?.code)
      ? error.code : 'INITIALIZATION_OR_SHUTDOWN_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, plantSnapshots, hasKey, thumbnailKey, storeThumbnail, backfillPlant, runBackfill };
