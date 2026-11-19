#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getFirebase } = require('../server/firebase.cjs');
const { FORMAT, ARRAY_START, stringify, documentId, inspectBackup } = require('./firestore-backup-format.cjs');

const BACKUPS = path.resolve(__dirname, '../backups');
const HELP = `Local read-only Firestore backup (Node.js 24).
  npm.cmd run backup:firestore -- --project PROJECT_ID
Requires the existing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and
FIREBASE_PRIVATE_KEY configuration. No default Project ID; no cloud writes.
Output: backups/<unique-run>/plants.json and integrity.json.
All fields of all top-level plants documents are included; no user/trash filters.`;

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 2 || args[0] !== '--project'
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(args[1])) {
    throw new Error('Use --project with an explicit Firebase Project ID');
  }
  return { projectId: args[1] };
}

function assertLocalProject(projectId, env) {
  if (['VERCEL', 'CI', 'GITHUB_ACTIONS', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']
    .some((key) => env[key])) throw new Error('Run only on a local computer without emulator/CI flags');
  if (env.FIREBASE_PROJECT_ID !== projectId) throw new Error('Project ID differs from Admin configuration');
  for (const key of ['REACT_APP_FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (env[key] && env[key] !== projectId) throw new Error('Conflicting Project IDs in environment');
  }
  if (!env.FIREBASE_CLIENT_EMAIL?.endsWith(`@${projectId}.iam.gserviceaccount.com`)
    || !env.FIREBASE_PRIVATE_KEY) throw new Error('Use the configured service account from the selected project');
}

function readTimestamp(timestamp) {
  if (!timestamp || !Number.isInteger(timestamp.seconds) || !Number.isInteger(timestamp.nanoseconds)
    || timestamp.nanoseconds < 0 || timestamp.nanoseconds >= 1_000_000_000) {
    throw new Error('Missing server read time');
  }
  // Build the whole seconds and fractional part separately, avoiding floating
  // point rounding to the next second near .999999999.
  return new Date(timestamp.seconds * 1000).toISOString()
    .replace(/\.\d{3}Z$/, `.${String(timestamp.nanoseconds).padStart(9, '0')}Z`);
}

function createReader({ credential, projectId, fetchImpl = fetch }) {
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  return async (kind, { readTime, pageToken } = {}) => {
    // The only permitted endpoints are reads. No document bodies or credentials
    // are sent to any storage provider, deployment service or arbitrary URL.
    if (!['list', 'count'].includes(kind)) throw new Error('Read operation required');
    const url = new URL(kind === 'list' ? `${root}/plants` : `${root}:runAggregationQuery`);
    if (kind === 'list') {
      url.searchParams.set('pageSize', '50');
      url.searchParams.set('readTime', readTime);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
    }
    const token = await credential.getAccessToken();
    const response = await fetchImpl(url, {
      method: kind === 'list' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      ...(kind === 'count' ? { body: JSON.stringify({
        readTime,
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId: 'plants' }] },
          aggregations: [{ alias: 'documentCount', count: {} }],
        },
      }) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error('Firestore read failed');
    return response.json();
  };
}

async function exportPlants({ projectId, readTime, read, backupRoot = BACKUPS }) {
  // Refuse a redirected backup directory, and never accept an output path from
  // the CLI. The directory is private on POSIX; Windows inherits local ACLs.
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(backupRoot)).isSymbolicLink()
    || path.resolve(await fs.realpath(backupRoot)).toLowerCase() !== path.resolve(backupRoot).toLowerCase()) {
    throw new Error('Backup directory must be a real local directory');
  }
  const runName = `plants-${projectId}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const runPath = path.join(backupRoot, runName);
  await fs.mkdir(runPath, { mode: 0o700 }); // Exclusive: never reuse a previous run.
  const partial = path.join(runPath, 'plants.json.partial');
  const output = path.join(runPath, 'plants.json');
  const metadata = { format: FORMAT, projectId, databaseId: '(default)', collection: 'plants',
    includesSubcollections: false, readTime, startedAt: new Date().toISOString() };
  const handle = await fs.open(partial, 'wx', 0o600);
  let documentCount = 0;
  const ids = new Set();
  try {
    await handle.writeFile(`${stringify(metadata).slice(0, -1)}${ARRAY_START}\n`);
    let pageToken;
    const pageTokens = new Set();
    do {
      const page = await read('list', { readTime, pageToken });
      if (!page || (page.documents !== undefined && !Array.isArray(page.documents))) {
        throw new Error('Invalid Firestore page');
      }
      for (const document of page.documents || []) {
        const id = documentId(document, projectId);
        if (ids.has(id)) throw new Error('Duplicate document in export');
        ids.add(id);
        await handle.writeFile(`${documentCount ? ',' : ''}${stringify({ id, document })}\n`);
        documentCount += 1;
      }
      pageToken = page.nextPageToken;
      if (pageToken && (typeof pageToken !== 'string' || pageTokens.has(pageToken))) {
        throw new Error('Invalid pagination token');
      }
      if (pageToken) pageTokens.add(pageToken);
    } while (pageToken); // A short page is NOT the end if a token is present.
    const countResponse = await read('count', { readTime });
    const counts = Array.isArray(countResponse)
      ? countResponse.filter((item) => item.result?.aggregateFields?.documentCount) : [];
    if (counts.length !== 1
      || counts[0].result.aggregateFields.documentCount.integerValue !== String(documentCount)) {
      throw new Error('Export count differs from Firestore snapshot count');
    }
    await handle.writeFile(`],"documentCount":${documentCount}}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const verified = await inspectBackup(partial);
  if (verified.documentCount !== documentCount) throw new Error('Local document count mismatch');
  // Hard-link publication is atomic and fails if the destination already exists;
  // rename() alone could replace an existing backup on some platforms.
  await fs.link(partial, output);
  await fs.unlink(partial);
  const integrity = { ...verified, file: 'plants.json', sourceCount: documentCount,
    verifiedAt: new Date().toISOString() };
  const manifest = await fs.open(path.join(runPath, 'integrity.json'), 'wx', 0o600);
  try {
    await manifest.writeFile(`${JSON.stringify(integrity, null, 2)}\n`);
    await manifest.sync();
  } finally {
    await manifest.close();
  }
  return { directory: runPath, documentCount, sizeBytes: verified.sizeBytes, sha256: verified.sha256, jsonValid: true };
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  assertLocalProject(options.projectId, process.env); // Before SDK initialization or reads.
  const { db, auth } = getFirebase(); // Existing Admin SDK configuration, unchanged.
  if (auth.app.options.projectId !== options.projectId || db.projectId !== options.projectId
    || db.databaseId !== '(default)') throw new Error('Initialized Admin app targets another project/database');
  try {
    // A projection reads no photo data and gives a server-issued snapshot time.
    const snapshot = await db.collection('plants').select().limit(1).get();
    const readTime = readTimestamp(snapshot.readTime);
    const read = createReader({ projectId: options.projectId, credential: auth.app.options.credential });
    const result = await exportPlants({ projectId: options.projectId, readTime, read });
    // Only a local path and integrity statistics; never raw fields or SDK errors.
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.terminate();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => {
    console.error('Backup failed. Check explicit --project, matching local Admin credentials, local directory permissions, available disk space and network/IAM. No completed backup is confirmed; retain earlier backups. Raw errors and document data are hidden.');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, assertLocalProject, readTimestamp, createReader, exportPlants };
