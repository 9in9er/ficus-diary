#!/usr/bin/env node
const sharp = require('sharp');
const { getFirebase } = require('../server/firebase.cjs');
const storage = require('../server/storage.cjs');
const { validId } = require('../server/photos.cjs');

const HELP = `Usage:
  npm run migrate:photos -- --project PROJECT_ID --user FIREBASE_UID [--plant PLANT_ID] [--dry-run]
  npm run migrate:photos -- --project PROJECT_ID --user FIREBASE_UID --plant PLANT_ID --apply

Default: dry-run (Firestore reads and local conversion only; no cloud writes).
--apply requires one plant ID. Legacy photo is ALWAYS preserved.
Use credentials for a test Firebase project and review the dry-run first.`;

function parseArgs(args) {
  const options = { apply: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--help') return { help: true };
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (['--project', '--user', '--plant'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Value required for ${flag}`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.project || !options.user) throw new Error('--project and --user are required');
  if (options.apply && options.dryRun) throw new Error('Choose --apply or --dry-run');
  if (options.apply && !options.plant) throw new Error('--apply requires --plant (one plant only)');
  if (options.plant && !validId(options.plant)) throw new Error('Invalid plant ID');
  return options;
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

async function migratePlant({ db, snapshot, userId, apply = false, files = storage, convert = convertLegacyPhoto }) {
  if (!snapshot.exists) throw new Error('Plant not found');
  const plant = snapshot.data();
  if (plant.userId !== userId) throw new Error('Owner does not match --user');
  if (plant.photoKey || plant.deletedAt || plant._photoDeleting
    || typeof plant.photo !== 'string' || !plant.photo.startsWith('data:image/')) return { status: 'skipped' };
  const bytes = await convert(plant.photo);
  if (!apply) return { status: 'dry-run', bytes: bytes.length };
  const photoKey = await files.storePhoto(userId, snapshot.id, bytes);
  await db.runTransaction(async (tx) => {
    const latest = await tx.get(snapshot.ref);
    const current = latest.data();
    if (!latest.exists || current.userId !== userId || current.photo !== plant.photo
      || current.photoKey || current.deletedAt || current._photoDeleting) throw new Error('Plant changed; no Firestore write made');
    tx.update(snapshot.ref, { photoKey });
  });
  return { status: 'migrated', bytes: bytes.length };
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  if (options.project !== process.env.FIREBASE_PROJECT_ID) throw new Error('--project does not match FIREBASE_PROJECT_ID');
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Use explicit test project credentials; emulator mode is not supported by this script');
  const { db } = getFirebase();
  const processPlant = async (snapshot) => {
    const result = await migratePlant({ db, snapshot, userId: options.user, apply: options.apply });
    console.log(JSON.stringify({ plantId: snapshot.id, ...result }));
  };
  if (options.plant) {
    await processPlant(await db.collection('plants').doc(options.plant).get());
    return;
  }
  // Bulk mode is read-only and paginated; writes are limited to --plant.
  let cursor;
  while (true) {
    let query = db.collection('plants').where('userId', '==', options.user).orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const snapshot of page.docs) await processPlant(snapshot);
    if (page.size < 100) break;
    cursor = page.docs[page.docs.length - 1];
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // Do not print raw SDK errors (they may contain signed URLs/credentials).
    console.error('Migration stopped:', error.code || (error.constructor === Error ? error.message : error.name));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, convertLegacyPhoto, migratePlant };
