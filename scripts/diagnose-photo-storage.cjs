#!/usr/bin/env node
const { getFirebase } = require('../server/firebase.cjs');
const { assertProject } = require('./verify-photo-migration.cjs');
const { parseArgs: parseBackfillArgs, plantSnapshots, hasKey } = require('./backfill-photo-thumbnails.cjs');
const { approximatePhotoFieldBytes } = require('./cleanup-base64-photos.cjs');

const HELP = `Read-only photo inventory (Node.js 24; configuration from .env.local).
  npm.cmd run diagnose:photo-storage -- --project PROJECT_ID
Scans all plants, all owners, wishlist and trash; no Object Storage access or writes.
Reports missing thumbnails, base64, base64 + photoKey, external URLs and estimated UTF-8 field bytes.
Counters describe Firestore fields, not verified object existence. No photo data, keys or URLs are printed.`;

function parseArgs(args) {
  const options = parseBackfillArgs(args);
  if (options.help) return options;
  if (options.apply || options.limit !== undefined || options.stopOnError) throw new Error('READ_ONLY_OPTIONS_REQUIRED');
  return { project: options.project };
}

const counters = () => ({ documents: 0, withPhotoKey: 0, withThumbnail: 0, missingThumbnail: 0,
  base64Photos: 0, base64WithPhotoKey: 0, externalPhotos: 0, estimatedBase64Bytes: 0 });
const isBase64 = (photo) => typeof photo === 'string' && /^data:image\/[^;,]+;base64,/.test(photo);
function isExternal(photo) {
  if (typeof photo !== 'string' || !/^https?:\/\//i.test(photo.trim())) return false;
  try { return ['http:', 'https:'].includes(new URL(photo.trim()).protocol); }
  catch { return false; }
}

function countPhoto(target, data) {
  const photoKey = hasKey(data, 'photoKey');
  const thumbKey = hasKey(data, 'photoThumbKey');
  target.documents += 1;
  if (photoKey) target.withPhotoKey += 1;
  if (thumbKey) target.withThumbnail += 1;
  if (photoKey && !thumbKey) target.missingThumbnail += 1;
  if (isBase64(data.photo)) {
    target.base64Photos += 1;
    if (photoKey) target.base64WithPhotoKey += 1;
    target.estimatedBase64Bytes += approximatePhotoFieldBytes(data.photo);
  }
  if (isExternal(data.photo)) target.externalPhotos += 1;
}

async function runDiagnosis({ db, options }) {
  const report = { mode: 'read-only', project: options.project, scope: 'all-plants-all-owners', ...counters(),
    bySection: { plants: counters(), wishlist: counters(), trash: counters() },
    processed: 0, skipped: 0, errors: 0, errorsByCode: {}, scanComplete: false };
  try {
    for await (const snapshot of plantSnapshots(db, ['photo', 'photoKey', 'photoThumbKey', 'deletedAt', 'isWishlisted'])) {
      try {
        const data = snapshot.exists && snapshot.data();
        if (!data || typeof data !== 'object') throw new Error('INVALID_DOCUMENT');
        countPhoto(report, data);
        countPhoto(report.bySection[data.deletedAt ? 'trash' : data.isWishlisted ? 'wishlist' : 'plants'], data);
        report.processed += 1;
      } catch {
        report.errors += 1;
        report.errorsByCode.INVALID_DOCUMENT = (report.errorsByCode.INVALID_DOCUMENT || 0) + 1;
      }
    }
    report.scanComplete = true;
  } catch {
    report.errors += 1;
    report.errorsByCode.FIRESTORE_SCAN_FAILED = 1;
  }
  report.estimatedBase64MiB = Number((report.estimatedBase64Bytes / 1024 / 1024).toFixed(3));
  return report;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  assertProject(options.project, process.env);
  const firebase = getFirebase();
  try {
    assertProject(options.project, process.env, firebase);
    const report = await runDiagnosis({ db: firebase.db, options });
    console.log(JSON.stringify({ summary: report }, null, 2));
    if (report.errors || !report.scanComplete) process.exitCode = 1;
  } finally { await firebase.db.terminate(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // Raw errors may contain SDK URLs, credentials or document data.
    console.error('Photo inventory stopped:', error?.code === 'PROJECT_MISMATCH'
      ? 'PROJECT_MISMATCH' : 'INVALID_OPTIONS_OR_INITIALIZATION_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runDiagnosis };
