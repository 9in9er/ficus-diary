#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectBackup } = require('./firestore-backup-format.cjs');

async function verifyBackup(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'integrity.json'), 'utf8'));
  if (manifest.file !== 'plants.json' || manifest.jsonValid !== true) throw new Error('Invalid integrity manifest');
  const actual = await inspectBackup(path.join(directory, 'plants.json'));
  for (const key of ['format', 'projectId', 'databaseId', 'collection', 'readTime', 'documentCount', 'sizeBytes', 'sha256']) {
    if (manifest[key] !== actual[key]) throw new Error('Backup integrity mismatch');
  }
  if (manifest.sourceCount !== actual.documentCount) throw new Error('Source document count mismatch');
  return { documentCount: actual.documentCount, sizeBytes: actual.sizeBytes, sha256: actual.sha256, jsonValid: true };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: npm.cmd run verify:firestore-backup -- "backups/<run-directory>"');
    process.exitCode = 1;
  } else {
    verifyBackup(path.resolve(args[0])).then((result) => console.log(JSON.stringify(result, null, 2))).catch(() => {
      console.error('Backup verification failed. JSON, count, file size or SHA-256 is invalid, or integrity.json is missing. Document data and raw errors are hidden.');
      process.exitCode = 1;
    });
  }
}

module.exports = { verifyBackup };
