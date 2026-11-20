#!/usr/bin/env node
// Audit only: Firestore queries and S3 HEAD/GET. No migration or cleanup entry points.
const { createHash } = require('node:crypto');
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const { getFirebase } = require('../server/firebase.cjs');
const { ownsPhotoKey, MAX_PHOTO_BYTES } = require('../server/storage.cjs');

const HELP = `Read-only photo migration audit (Node.js 24; configuration from .env.local).
  npm.cmd run verify:photos -- --project PROJECT_ID
    [--expect-photo-keys 264] [--expect-trash-base64 46]
Scans ALL top-level plants, all owners, wishlist and trash, in pages of 100.
Downloads each valid photoKey using HEAD + conditional GET and fully decodes WebP.
No Firestore writes, uploads, deletions, signed URLs or local image files.
Exit codes: 0 = complete with no errors/problems; 1 = errors/incomplete;
2 = potential problems only. Existing photo + photoKey and trash base64 are informational.`;

class AuditError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  const names = { '--project': 'project', '--expect-photo-keys': 'expectPhotoKeys',
    '--expect-trash-base64': 'expectTrashBase64' };
  for (let i = 0; i < args.length; i += 2) {
    const name = Object.hasOwn(names, args[i]) ? names[args[i]] : undefined;
    const value = args[i + 1];
    if (!name || Object.hasOwn(options, name) || !value || value.startsWith('--')) {
      throw new AuditError('INVALID_OPTIONS_USE_HELP');
    }
    if (name === 'project') {
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) throw new AuditError('INVALID_PROJECT_ID');
      options.project = value;
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new AuditError('INVALID_EXPECTED_COUNT');
      }
      options[name] = Number(value);
    }
  }
  if (!options.project) throw new AuditError('PROJECT_REQUIRED');
  return options;
}

function assertProject(project, env, firebase) {
  if (env.FIREBASE_PROJECT_ID !== project) throw new AuditError('PROJECT_MISMATCH');
  for (const key of ['REACT_APP_FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (env[key] && env[key] !== project) throw new AuditError('PROJECT_MISMATCH');
  }
  if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new AuditError('EMULATOR_NOT_SUPPORTED');
  }
  if (firebase && (firebase.auth.app.options.projectId !== project
    || firebase.db.projectId !== project || firebase.db.databaseId !== '(default)')) {
    throw new AuditError('PROJECT_MISMATCH');
  }
}

function createStorageReader(env) {
  const { YANDEX_BUCKET_NAME: bucket, YANDEX_S3_ENDPOINT: endpoint,
    YANDEX_ACCESS_KEY_ID: accessKeyId, YANDEX_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) throw new AuditError('STORAGE_NOT_CONFIGURED');
  // Never send configured credentials to a URL taken from a document or an arbitrary endpoint.
  if (endpoint !== 'https://storage.yandexcloud.net' && endpoint !== 'https://storage.yandexcloud.net/') {
    throw new AuditError('UNEXPECTED_STORAGE_ENDPOINT');
  }
  return { bucket, client: new S3Client({ endpoint, region: 'ru-central1', forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }) };
}

function storageError(error) {
  if (error instanceof AuditError) return error;
  const status = error?.$metadata?.httpStatusCode;
  // A 403, timeout or network failure is not evidence that an object is absent.
  if (status === 404 || (!status && ['NotFound', 'NoSuchKey'].includes(error?.name))) {
    return new AuditError('OBJECT_MISSING');
  }
  if (status === 403 || status === 401) return new AuditError('OBJECT_ACCESS_DENIED');
  if (status === 412) return new AuditError('OBJECT_CHANGED');
  return new AuditError('OBJECT_READ_FAILED');
}

async function decodeWebP(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new AuditError('INVALID_WEBP');
  }
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 1600 * 1600, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== 'webp' || !metadata.width || !metadata.height
      || Math.max(metadata.width, metadata.height) > 1600 || (metadata.pages || 1) !== 1) {
      throw new AuditError('INVALID_WEBP');
    }
    // metadata() alone accepts some damaged images. Force a full pixel decode.
    await image.timeout({ seconds: 10 }).raw().toBuffer();
    return { width: metadata.width, height: metadata.height };
  } catch { throw new AuditError('INVALID_WEBP'); }
}

async function verifyObject({ client, bucket, key, timeoutMs = 60_000 }) {
  const controller = new AbortController();
  let body;
  const timer = setTimeout(() => { controller.abort(); body?.destroy?.(); }, timeoutMs);
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: controller.signal });
    if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength <= 0
      || head.ContentLength > MAX_PHOTO_BYTES) throw new AuditError('INVALID_OBJECT_SIZE');
    if (head.ContentType !== 'image/webp') throw new AuditError('INVALID_CONTENT_TYPE');
    if (typeof head.ETag !== 'string' || !head.ETag) throw new AuditError('MISSING_ETAG');
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag }),
      { abortSignal: controller.signal });
    body = object.Body;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new AuditError('OBJECT_READ_FAILED');
    if (object.ETag !== head.ETag) throw new AuditError('OBJECT_CHANGED');
    if (object.ContentLength !== head.ContentLength) throw new AuditError('OBJECT_SIZE_MISMATCH');
    if (object.ContentType !== 'image/webp') throw new AuditError('INVALID_CONTENT_TYPE');
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      if (controller.signal.aborted) throw new AuditError('OBJECT_READ_TIMEOUT');
      if (!(chunk instanceof Uint8Array)) throw new AuditError('OBJECT_READ_FAILED');
      total += chunk.length;
      if (total > MAX_PHOTO_BYTES || total > head.ContentLength) throw new AuditError('OBJECT_SIZE_MISMATCH');
      chunks.push(chunk);
    }
    if (controller.signal.aborted) throw new AuditError('OBJECT_READ_TIMEOUT');
    if (total !== head.ContentLength) throw new AuditError('OBJECT_SIZE_MISMATCH');
    const bytes = Buffer.concat(chunks, total);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    // Migration uploads have this metadata. Older ordinary uploads may legitimately lack it.
    for (const metadata of [head.Metadata, object.Metadata]) {
      if (metadata && Object.hasOwn(metadata, 'sha256') && metadata.sha256 !== checksum) {
        throw new AuditError('CHECKSUM_MISMATCH');
      }
    }
    return { bytes: total, ...await decodeWebP(bytes) };
  } catch (error) {
    if (controller.signal.aborted) throw new AuditError('OBJECT_READ_TIMEOUT');
    throw storageError(error);
  } finally {
    clearTimeout(timer);
    body?.destroy?.();
  }
}

const validPlantId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const safePlantId = (id) => validPlantId(id) ? id
  : `invalid-id-sha256:${createHash('sha256').update(String(id)).digest('hex')}`;
const hasBase64 = (plant) => typeof plant.photo === 'string' && /^data:image\/[^;,]+;base64,/.test(plant.photo);
const hasKey = (plant) => Object.hasOwn(plant, 'photoKey') && plant.photoKey !== null;

async function* plantSnapshots(db) {
  let cursor;
  while (true) {
    let query = db.collection('plants').orderBy('__name__').limit(100)
      .select('userId', 'photo', 'photoKey', 'deletedAt', '_photoDeleting');
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const snapshot of page.docs) yield snapshot;
    if (page.size < 100) return;
    cursor = page.docs[page.docs.length - 1];
  }
}

async function runVerification({ db, options, connection, onResult = () => {} }) {
  const report = { mode: 'read-only', project: options.project, scope: 'all-plants-all-owners',
    startedAt: new Date().toISOString(), totalDocuments: 0, photoKeyFields: 0, withPhotoKey: 0,
    photoAndPhotoKeyFields: 0, base64AndPhotoKey: 0, withoutPhotoKey: 0,
    trashPlants: 0, trashWithBase64: 0, trashWithBase64WithoutPhotoKey: 0,
    activeBase64WithoutPhotoKey: 0, attemptedObjects: 0, verified: 0, verifiedBytes: 0,
    failedPhotoKeys: 0, errors: 0, potentialProblems: 0, errorsByCode: {}, problemsByCode: {},
    scanComplete: false, checksPassed: false, issues: [] };
  const problem = (code) => {
    report.potentialProblems += 1;
    report.problemsByCode[code] = (report.problemsByCode[code] || 0) + 1;
  };
  try {
    for await (const snapshot of plantSnapshots(db)) {
      report.totalDocuments += 1;
      const plantId = safePlantId(snapshot.id);
      const warnings = [];
      let keyed = false;
      try {
        const plant = snapshot.data();
        const base64 = hasBase64(plant);
        keyed = hasKey(plant);
        const trash = Boolean(plant.deletedAt);
        if (Object.hasOwn(plant, 'photoKey')) report.photoKeyFields += 1;
        if (Object.hasOwn(plant, 'photo') && Object.hasOwn(plant, 'photoKey')) report.photoAndPhotoKeyFields += 1;
        if (keyed) report.withPhotoKey += 1;
        else report.withoutPhotoKey += 1;
        if (base64 && keyed) report.base64AndPhotoKey += 1;
        if (trash) report.trashPlants += 1;
        if (trash && base64) report.trashWithBase64 += 1;
        if (trash && base64 && !keyed) report.trashWithBase64WithoutPhotoKey += 1;
        if (!trash && base64 && !keyed) {
          report.activeBase64WithoutPhotoKey += 1;
          warnings.push('ACTIVE_BASE64_WITHOUT_PHOTO_KEY');
        }
        if (plant._photoDeleting) warnings.push('PHOTO_DELETION_IN_PROGRESS');
        for (const code of warnings) problem(code);
        if (!keyed) {
          const result = { plantId, status: 'no-photo-key', warnings };
          if (warnings.length) report.issues.push(result);
          onResult(result);
          continue;
        }
        if (!validPlantId(snapshot.id)) throw new AuditError('INVALID_PLANT_ID');
        if (typeof plant.userId !== 'string' || !plant.userId.trim() || plant.userId.length > 128) {
          throw new AuditError('INVALID_OWNER_UID');
        }
        if (typeof plant.photoKey !== 'string' || !plant.photoKey) throw new AuditError('INVALID_PHOTO_KEY');
        if (!ownsPhotoKey(plant.userId, snapshot.id, plant.photoKey)) throw new AuditError('PHOTO_KEY_PATH_MISMATCH');
        report.attemptedObjects += 1;
        const result = { plantId, status: 'verified', ...await verifyObject({ ...connection, key: plant.photoKey }), warnings };
        report.verified += 1;
        report.verifiedBytes += result.bytes;
        if (warnings.length) report.issues.push(result);
        onResult(result);
      } catch (error) {
        const code = error instanceof AuditError ? error.code : 'PLANT_CHECK_FAILED';
        report.errors += 1;
        if (keyed) report.failedPhotoKeys += 1;
        report.errorsByCode[code] = (report.errorsByCode[code] || 0) + 1;
        const result = { plantId, status: 'error', code, warnings };
        report.issues.push(result);
        onResult(result);
      }
    }
    report.scanComplete = true;
  } catch {
    report.errors += 1;
    report.errorsByCode.FIRESTORE_SCAN_FAILED = 1;
    report.issues.push({ status: 'error', code: 'FIRESTORE_SCAN_FAILED' });
  }
  if (report.scanComplete) {
    if (!report.withPhotoKey) problem('NO_PHOTO_KEYS');
    for (const [option, field, code] of [
      ['expectPhotoKeys', 'withPhotoKey', 'PHOTO_KEY_COUNT_MISMATCH'],
      ['expectTrashBase64', 'trashWithBase64', 'TRASH_BASE64_COUNT_MISMATCH'],
    ]) {
      if (options[option] !== undefined) {
        report[option] = options[option];
        if (report[field] !== options[option]) problem(code);
      }
    }
  }
  report.checksPassed = report.scanComplete && report.errors === 0 && report.potentialProblems === 0;
  report.completedAt = new Date().toISOString();
  return report;
}

function reportExitCode(report) {
  return report.errors || !report.scanComplete ? 1 : report.potentialProblems ? 2 : 0;
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
    const report = await runVerification({ db: firebase.db, options, connection,
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
    // Do not print SDK messages/stacks, keys, URLs, UID, photo data or document contents.
    console.error('Photo verification stopped:', error instanceof AuditError ? error.code : 'INITIALIZATION_OR_SHUTDOWN_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, assertProject, createStorageReader, decodeWebP, verifyObject,
  runVerification, reportExitCode };
