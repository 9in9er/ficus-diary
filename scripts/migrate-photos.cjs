#!/usr/bin/env node
const sharp = require('sharp');
const { getFirebase } = require('../server/firebase.cjs');
const storage = require('../server/storage.cjs');
const { validId } = require('../server/photos.cjs');

const HELP = `Usage (Node.js 24; credentials from .env.local):
  npm run migrate:photos -- --project PROJECT_ID --user FIREBASE_UID --all --dry-run
  npm run migrate:photos -- --project PROJECT_ID --user FIREBASE_UID --all --apply [--limit 10]
  npm run migrate:photos -- --project PROJECT_ID --user FIREBASE_UID --plant PLANT_ID [--dry-run | --apply]

Default: dry-run (Firestore reads and local conversion only; no cloud writes).
--apply requires either --plant or --all. They cannot be combined.
--limit bounds eligible attempts, including errors, not skipped documents.
Plants are processed sequentially in document ID order, including the wishlist.
Errors continue by default; --stop-on-error stops after the first plant error.
Legacy photo is ALWAYS preserved. Re-run the same command to resume.
Do not run concurrent migrations or delete plant files during migration.`;

class MigrationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function invalid(message) { throw new MigrationError('INVALID_OPTIONS', message); }

function parseArgs(args) {
  const options = { apply: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--help') return { help: true };
    if (seen.has(flag)) invalid('Duplicate option; use --help');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--all') options.all = true;
    else if (flag === '--stop-on-error') options.stopOnError = true;
    else if (['--project', '--user', '--plant', '--limit'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) invalid('Value required for ' + flag);
      options[flag.slice(2)] = value;
    } else invalid('Unknown option; use --help');
  }
  if (!options.project || !options.user) invalid('--project and --user are required');
  if (options.apply && options.dryRun) invalid('Choose --apply or --dry-run');
  if (options.plant && options.all) invalid('Choose --plant or --all');
  if (options.apply && !options.plant && !options.all) invalid('--apply requires --plant or explicit --all');
  if (options.plant && !validId(options.plant)) invalid('Invalid plant ID');
  // Custom Auth UIDs need not match the stricter plant ID alphabet.
  if (options.user.length > 128 || !options.user.trim()) invalid('Invalid user UID');
  if (options.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.limit) || !Number.isSafeInteger(Number(options.limit))) {
      invalid('--limit must be a positive safe integer');
    }
    options.limit = Number(options.limit);
    if (options.plant) invalid('--limit is only supported for bulk migration');
  }
  return options;
}

function assertProject(project, env, firebase) {
  if (project !== env.FIREBASE_PROJECT_ID) throw new MigrationError('PROJECT_MISMATCH', '--project does not match FIREBASE_PROJECT_ID');
  if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new MigrationError('EMULATOR_NOT_SUPPORTED', 'Emulator mode is not supported by this script');
  }
  for (const key of ['REACT_APP_FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (env[key] && env[key] !== project) throw new MigrationError('PROJECT_MISMATCH', 'Conflicting project IDs in environment');
  }
  if (firebase && (firebase.auth.app.options.projectId !== project || firebase.db.projectId !== project
    || firebase.db.databaseId !== '(default)')) {
    throw new MigrationError('PROJECT_MISMATCH', 'Initialized Admin app targets another project/database');
  }
}

async function convertLegacyPhoto(photo) {
  const match = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
  if (!match) throw new Error('Unsupported legacy image');
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('Invalid legacy size');
  const converted = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
    .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toBuffer();
  if (converted.length > storage.MAX_PHOTO_BYTES) throw new Error('Converted image too large');
  return converted;
}

function skipReason(plant) {
  if (plant.photoKey) return 'photoKey';
  if (plant.deletedAt) return 'trash';
  if (plant._photoDeleting) return 'deleting';
  if (typeof plant.photo !== 'string' || !/^data:image\/[^;,]+;base64,/.test(plant.photo)) return 'no-base64';
  return null;
}

async function migratePlant({ db, snapshot, userId, apply = false, files = storage,
  convert = convertLegacyPhoto, onStored = () => {} }) {
  if (!snapshot.exists) throw new MigrationError('PLANT_NOT_FOUND', 'Plant not found');
  const plant = snapshot.data();
  if (plant.userId !== userId) throw new MigrationError('OWNER_MISMATCH', 'Owner does not match --user');
  const reason = skipReason(plant);
  if (reason) return { status: 'skipped', reason };
  if (!validId(snapshot.id)) throw new MigrationError('INVALID_PLANT_ID');
  let bytes;
  try { bytes = await convert(plant.photo); }
  catch { throw new MigrationError('CONVERSION_FAILED'); }
  if (!apply) return { status: 'dry-run', bytes: bytes.length };
  let stored;
  try { stored = await files.storeMigrationPhoto(userId, snapshot.id, bytes); }
  catch { throw new MigrationError('STORAGE_FAILED'); }
  // Count successful PUTs even if the subsequent Firestore transaction fails.
  onStored(stored);
  try {
    await db.runTransaction(async (tx) => {
      const latest = await tx.get(snapshot.ref);
      const current = latest.data();
      if (!latest.exists || current.userId !== userId || current.photo !== plant.photo
        || skipReason(current)) throw new MigrationError('PLANT_CHANGED', 'Plant changed; no Firestore write made');
      tx.update(snapshot.ref, { photoKey: stored.photoKey }); // Never change photo or other fields.
    });
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('FIRESTORE_FAILED');
  }
  return { status: 'migrated', bytes: bytes.length, ...stored };
}

async function* plantSnapshots(db, options) {
  if (options.plant) {
    yield await db.collection('plants').doc(options.plant).get();
    return;
  }
  let cursor;
  while (true) {
    let query = db.collection('plants').where('userId', '==', options.user).orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const snapshot of page.docs) yield snapshot;
    if (page.size < 100) break;
    cursor = page.docs[page.docs.length - 1];
  }
}

async function runMigration({ db, options, files = storage, convert = convertLegacyPhoto, onResult = () => {} }) {
  const report = { mode: options.apply ? 'apply' : 'dry-run', project: options.project, user: options.user,
    totalFound: 0, eligible: 0, attempted: 0, migrated: 0, dryRunPhotos: 0, skipped: 0,
    deferred: 0, errors: 0, estimatedBytes: 0, uploadedBytes: 0, reusedObjects: 0,
    skippedByReason: {}, stopped: false, scanComplete: false };
  try {
    for await (const snapshot of plantSnapshots(db, options)) {
      report.totalFound += 1;
      try {
        const plant = snapshot.exists && snapshot.data();
        if (!plant) throw new MigrationError('PLANT_NOT_FOUND');
        if (plant.userId !== options.user) throw new MigrationError('OWNER_MISMATCH');
        const reason = skipReason(plant);
        if (reason) {
          report.skipped += 1;
          report.skippedByReason[reason] = (report.skippedByReason[reason] || 0) + 1;
          onResult({ plantId: snapshot.id, status: 'skipped', reason });
          continue;
        }
        report.eligible += 1;
        if (report.attempted >= (options.limit ?? Infinity)) {
          report.deferred += 1;
          continue;
        }
        report.attempted += 1;
        const result = await migratePlant({ db, snapshot, userId: options.user, apply: options.apply, files, convert,
          onStored: ({ uploadedBytes, reused }) => {
            report.uploadedBytes += uploadedBytes;
            if (reused) report.reusedObjects += 1;
          } });
        if (result.status === 'migrated') report.migrated += 1;
        else report.dryRunPhotos += 1;
        report.estimatedBytes += result.bytes;
        onResult({ plantId: snapshot.id, ...result });
      } catch (error) {
        report.errors += 1;
        onResult({ plantId: snapshot.id, status: 'error',
          code: error instanceof MigrationError ? error.code : 'PLANT_FAILED' });
        if (options.stopOnError) { report.stopped = true; break; }
      }
    }
    report.scanComplete = !report.stopped;
  } catch {
    report.errors += 1;
    report.stopped = true;
    report.fatalError = 'FIRESTORE_SCAN_FAILED';
  }
  return report;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  assertProject(options.project, process.env); // Before SDK initialization or reads.
  const firebase = getFirebase();
  try {
    assertProject(options.project, process.env, firebase);
    const report = await runMigration({ db: firebase.db, options,
      onResult: (result) => console.log(JSON.stringify(result)) });
    console.log(JSON.stringify({ summary: report }, null, 2));
    if (report.errors) process.exitCode = 1;
  } finally {
    await firebase.db.terminate();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // Never print raw SDK messages, URLs, credentials or photo data.
    console.error('Migration stopped:', error instanceof MigrationError ? error.message : 'INITIALIZATION_OR_SHUTDOWN_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, assertProject, convertLegacyPhoto, skipReason, migratePlant, runMigration };
