#!/usr/bin/env node
const { getFirebase } = require('../server/firebase.cjs');
const storage = require('../server/storage.cjs');
const { assertProject, convertLegacyPhoto } = require('./migrate-photos.cjs');

const PROJECT = 'my-plants-app-8f6fc';
const TARGETS = Object.freeze(['mnV2BvHKuxE7XZr5mp1B', 'yJ8a7aS3fLK0tb3dfqkM']);
const HELP = `Targeted migration of exactly two remaining ficus-diary photos (Node.js 24).
  npm.cmd run migrate:remaining-photos -- --project ${PROJECT} --dry-run
  npm.cmd run migrate:remaining-photos -- --project ${PROJECT} --apply
Fixed document IDs:
  ${TARGETS.join('\n  ')}
Default: dry-run; Firestore point reads and in-memory conversion only, no S3 calls.
No --user, --plant, --all or scope overrides. Owners are read from each document.
Both documents are preflighted before any upload. Legacy photo is always preserved.
Apply rereads each document before upload and again in the Firestore transaction.
Run sequentially, without concurrent migrations or photo/plant deletion.
Output contains only fixed plant IDs, safe status codes and byte counts.`;

class TargetedError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function validateOptions(options) {
  if (!options || options.project !== PROJECT || typeof options.apply !== 'boolean'
    || Object.keys(options).some((key) => !['project', 'apply'].includes(key))) {
    throw new TargetedError('INVALID_OPTIONS_OR_PROJECT');
  }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { apply: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new TargetedError('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--project') {
      options.project = args[++i];
    } else if (flag === '--apply') options.apply = true;
    else if (flag !== '--dry-run') throw new TargetedError('UNKNOWN_OPTION_USE_HELP');
  }
  if (seen.has('--apply') && seen.has('--dry-run')) throw new TargetedError('CONFLICTING_MODES');
  validateOptions(options);
  return options;
}

function assertRef(ref, id) {
  if (!TARGETS.includes(id) || ref?.id !== id || ref?.path !== `plants/${id}`) {
    throw new TargetedError('DOCUMENT_SCOPE_MISMATCH');
  }
}

function readData(snapshot, id) {
  assertRef(snapshot?.ref, id);
  if (snapshot.id !== id) throw new TargetedError('DOCUMENT_SCOPE_MISMATCH');
  if (!snapshot.exists) throw new TargetedError('PLANT_NOT_FOUND');
  const data = snapshot.data();
  if (!data || typeof data.userId !== 'string' || !data.userId.trim() || data.userId.length > 128) {
    throw new TargetedError('INVALID_OWNER_UID');
  }
  return data;
}

function hasKey(data) {
  // Null is treated as no key; malformed non-null values must never be overwritten.
  return Object.hasOwn(data, 'photoKey') && data.photoKey !== null;
}

function assertEligible(data) {
  if (hasKey(data)) throw new TargetedError('PHOTO_KEY_ALREADY_PRESENT');
  if (data.deletedAt) throw new TargetedError('PLANT_IN_TRASH');
  if (data._photoDeleting) throw new TargetedError('PHOTO_DELETION_IN_PROGRESS');
  if (typeof data.photo !== 'string' || !/^data:image\/[^;,]+;base64,/.test(data.photo)) {
    throw new TargetedError('NO_BASE64_PHOTO');
  }
}

function assertUnchanged(snapshot, prepared) {
  const current = readData(snapshot, prepared.id);
  if (current.userId !== prepared.data.userId || current.photo !== prepared.data.photo) {
    throw new TargetedError('PLANT_CHANGED');
  }
  assertEligible(current);
}

async function pointRead(db, id) {
  if (!TARGETS.includes(id)) throw new TargetedError('DOCUMENT_SCOPE_MISMATCH');
  const ref = db.collection('plants').doc(id);
  assertRef(ref, id);
  try { return await ref.get(); }
  catch { throw new TargetedError('FIRESTORE_READ_FAILED'); }
}

async function applyPrepared(db, prepared, files, onStored) {
  // Conversion may have taken time: recheck all guards before even an S3 HEAD/PUT.
  assertUnchanged(await pointRead(db, prepared.id), prepared);
  let stored;
  try { stored = await files.storeMigrationPhoto(prepared.data.userId, prepared.id, prepared.bytes); }
  catch { throw new TargetedError('STORAGE_FAILED'); }
  onStored(stored);
  if (stored.photoKey !== storage.migrationPhotoKey(prepared.data.userId, prepared.id, prepared.bytes)) {
    throw new TargetedError('UNEXPECTED_STORED_KEY');
  }
  try {
    await db.runTransaction(async (tx) => {
      const ref = db.collection('plants').doc(prepared.id);
      assertRef(ref, prepared.id);
      const latest = await tx.get(ref);
      assertUnchanged(latest, prepared);
      tx.update(ref, { photoKey: stored.photoKey }); // Preserve photo and every other field.
    });
  } catch (error) {
    if (error instanceof TargetedError) throw error;
    throw new TargetedError('FIRESTORE_FAILED');
  }
  return stored;
}

async function runTargetedMigration({ db, options, files = storage, convert = convertLegacyPhoto, onResult = () => {} }) {
  validateOptions(options); // Before any reads, even when called without the CLI.
  const report = { mode: options.apply ? 'apply' : 'dry-run', project: PROJECT, targetIds: [...TARGETS],
    totalTargets: TARGETS.length, documentsFound: 0, eligible: 0, dryRunPhotos: 0,
    alreadyMigrated: 0, attempted: 0, migrated: 0, errors: 0, notApplied: 0,
    estimatedBytes: 0, uploadedBytes: 0, reusedObjects: 0,
    preflightComplete: false, preflightPassed: false, readyToApply: false, completed: false, results: [] };
  const prepared = [];
  // Read and convert BOTH fixed documents before any upload. No collection query is used.
  for (const id of TARGETS) {
    const result = { plantId: id };
    report.results.push(result);
    try {
      const snapshot = await pointRead(db, id);
      if (snapshot.exists) report.documentsFound += 1;
      const data = readData(snapshot, id);
      if (hasKey(data)) {
        if (!storage.ownsPhotoKey(data.userId, id, data.photoKey)) throw new TargetedError('INVALID_EXISTING_PHOTO_KEY');
        result.status = 'already-migrated';
        report.alreadyMigrated += 1;
        continue;
      }
      assertEligible(data);
      let bytes;
      try { bytes = await convert(data.photo); }
      catch { throw new TargetedError('CONVERSION_FAILED'); }
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > storage.MAX_PHOTO_BYTES) {
        throw new TargetedError('CONVERSION_FAILED');
      }
      report.eligible += 1;
      report.estimatedBytes += bytes.length;
      result.status = options.apply ? 'not-applied' : 'dry-run';
      result.bytes = bytes.length;
      if (!options.apply) report.dryRunPhotos += 1;
      prepared.push({ id, data, bytes, result });
    } catch (error) {
      report.errors += 1;
      result.status = 'error';
      result.code = error instanceof TargetedError ? error.code : 'PREFLIGHT_FAILED';
    }
  }
  report.preflightComplete = true;
  report.preflightPassed = report.errors === 0;
  report.readyToApply = !options.apply && report.preflightPassed && report.eligible > 0;
  if (options.apply && report.preflightPassed) {
    for (const entry of prepared) {
      report.attempted += 1;
      try {
        const stored = await applyPrepared(db, entry, files, ({ uploadedBytes, reused }) => {
          report.uploadedBytes += uploadedBytes;
          if (reused) report.reusedObjects += 1;
        });
        report.migrated += 1;
        entry.result.status = 'migrated';
        entry.result.uploadedBytes = stored.uploadedBytes;
        entry.result.reused = stored.reused;
      } catch (error) {
        report.errors += 1;
        entry.result.status = 'error';
        entry.result.code = error instanceof TargetedError ? error.code : 'PLANT_FAILED';
        break; // Partial successes are retained; a subsequent explicit retry resumes safely.
      }
    }
  }
  report.notApplied = report.results.filter((result) => result.status === 'not-applied').length;
  report.completed = report.errors === 0 && report.notApplied === 0;
  // Whitelisted result fields only: never spread storage results/data/errors into output.
  for (const result of report.results) onResult({ ...result });
  return report;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  assertProject(PROJECT, process.env);
  const firebase = getFirebase();
  try {
    assertProject(PROJECT, process.env, firebase);
    const report = await runTargetedMigration({ db: firebase.db, options,
      onResult: (result) => console.log(JSON.stringify(result)) });
    console.log(JSON.stringify({ summary: report }, null, 2));
    if (!report.completed) process.exitCode = 1;
  } finally { await firebase.db.terminate(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // Never print raw SDK errors/stacks, user IDs, credentials, photo data or URLs.
    const code = error instanceof TargetedError ? error.code : 'PROJECT_INITIALIZATION_OR_SHUTDOWN_FAILED';
    console.error('Targeted migration stopped:', code);
    process.exitCode = 1;
  });
}

module.exports = { PROJECT, TARGETS, parseArgs, runTargetedMigration };
