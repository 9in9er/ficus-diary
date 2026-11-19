const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { parseArgs, assertLocalProject, readTimestamp, createReader, exportPlants } = require('../../scripts/backup-firestore.cjs');
const { inspectBackup } = require('../../scripts/firestore-backup-format.cjs');
const { verifyBackup } = require('../../scripts/verify-firestore-backup.cjs');

const projectId = 'ficus-diary';
const readTime = '2026-11-20T12:00:00.123456000Z';
const document = (id, fields = {}) => ({
  name: `projects/${projectId}/databases/(default)/documents/plants/${id}`,
  fields, createTime: readTime, updateTime: readTime,
});
const count = (n) => [{ result: { aggregateFields: { documentCount: { integerValue: String(n) } } } }];

async function temporaryRoot(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ficus-backup-test-'));
  // Delete only the verified temporary directory created by this test.
  t.after(async () => {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ficus-backup-test-'));
    await fs.rm(directory, { recursive: true });
  });
  return directory;
}

function readerFor(documents) {
  return async (kind) => kind === 'list' ? { documents } : count(documents.length);
}

test('requires explicit Project ID and rejects conflicting project, emulator and deployment environments', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--project', '../outside']));
  assert.throws(() => parseArgs(['--project', projectId, '--project', projectId]));
  assert.deepEqual(parseArgs(['--project', projectId]), { projectId });
  const env = { FIREBASE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: `backup@${projectId}.iam.gserviceaccount.com`, FIREBASE_PRIVATE_KEY: 'fake-test-key' };
  assert.doesNotThrow(() => assertLocalProject(projectId, env));
  for (const conflict of [
    { FIREBASE_PROJECT_ID: 'other-project' }, { REACT_APP_FIREBASE_PROJECT_ID: 'other-project' },
    { FIREBASE_CLIENT_EMAIL: 'backup@other-project.iam.gserviceaccount.com' },
    { FIRESTORE_EMULATOR_HOST: 'localhost:8080' }, { VERCEL: '1' }, { CI: 'true' },
  ]) assert.throws(() => assertLocalProject(projectId, { ...env, ...conflict }));
});

test('server read time preserves all fractional digits', () => {
  assert.equal(readTimestamp(new Timestamp(1795176000, 123456000)), readTime);
  assert.equal(readTimestamp(new Timestamp(1795176000, 999999999)), '2026-11-20T12:00:00.999999999Z');
});

test('read transport uses existing credential and only read endpoints with a fixed readTime', async () => {
  const requests = [];
  const read = createReader({ projectId, credential: { getAccessToken: async () => ({ access_token: 'test-token' }) },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; } });
  await read('list', { readTime, pageToken: 'next-test-page' });
  await read('count', { readTime });
  await assert.rejects(read('write'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.origin, 'https://firestore.googleapis.com');
  assert.equal(requests[0].url.searchParams.get('readTime'), readTime);
  assert.equal(requests[0].url.searchParams.get('pageToken'), 'next-test-page');
  assert.equal(requests[0].url.searchParams.has('mask'), false);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  const aggregate = JSON.parse(requests[1].options.body);
  assert.equal(requests[1].options.method, 'POST');
  assert.ok(requests[1].url.pathname.endsWith(':runAggregationQuery'));
  assert.equal(aggregate.readTime, readTime);
  assert.deepEqual(aggregate.structuredAggregationQuery.structuredQuery.from, [{ collectionId: 'plants' }]);
});

test('round trip keeps full base64, every field and nested special types; independent SHA and JSON checks agree', async (t) => {
  const backupRoot = await temporaryRoot(t);
  const photo = `data:image/jpeg;base64,${'QUJD'.repeat(200_000)}`;
  const fields = {
    photo: { stringValue: photo }, id: { stringValue: 'an-existing-data-field' },
    notes: { arrayValue: { values: [{ mapValue: { fields: { text: { stringValue: 'Private\nзаметка' } } } }] } },
    wateringLog: { arrayValue: { values: [{ timestampValue: readTime }] } },
    fertilizingLog: { arrayValue: { values: [{ stringValue: '2026-11-19' }] } },
    isWishlisted: { booleanValue: true }, deletedAt: { stringValue: '2026-11-20' },
    big: { integerValue: '9223372036854775807' }, small: { integerValue: '-9223372036854775808' },
    position: { geoPointValue: { latitude: 55.7558, longitude: 37.6173 } },
    reference: { referenceValue: `projects/${projectId}/databases/(default)/documents/plants/other` },
    blob: { bytesValue: 'AAH/' }, empty: { nullValue: null },
    nested: { mapValue: { fields: { float: { doubleValue: -0 }, nan: { doubleValue: 'NaN' },
      posInf: { doubleValue: 'Infinity' }, negInf: { doubleValue: '-Infinity' },
      vector: { mapValue: { fields: { __type__: { stringValue: '__vector__' },
        value: { arrayValue: { values: [{ doubleValue: 0.125 }] } } } } } } } },
  };
  const original = document('plant-1', fields);
  const result = await exportPlants({ projectId, readTime, backupRoot, read: readerFor([original]) });
  const bytes = await fs.readFile(path.join(result.directory, 'plants.json'));
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.equal(parsed.documentCount, 1);
  assert.equal(parsed.documents[0].id, 'plant-1');
  assert.deepEqual(parsed.documents[0].document, original);
  assert.equal(parsed.documents[0].document.fields.photo.stringValue.length, photo.length);
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await verifyBackup(result.directory)).sha256, result.sha256);
  assert.deepEqual((await fs.readdir(result.directory)).sort(), ['integrity.json', 'plants.json']);
});

test('pagination continues after short and empty pages and compares count at the same snapshot', async (t) => {
  const backupRoot = await temporaryRoot(t);
  const requests = [];
  const read = async (kind, options) => {
    requests.push({ kind, ...options });
    assert.equal(options.readTime, readTime);
    if (kind === 'count') return count(2);
    if (!options.pageToken) return { documents: [document('one')], nextPageToken: 'second' };
    if (options.pageToken === 'second') return { nextPageToken: 'third' };
    return { documents: [document('two')] };
  };
  const result = await exportPlants({ projectId, readTime, backupRoot, read });
  assert.equal(result.documentCount, 2);
  assert.deepEqual(requests.map((r) => r.kind), ['list', 'list', 'list', 'count']);
});

test('empty collection creates a valid zero-document backup and repeated runs never replace earlier files', async (t) => {
  const backupRoot = await temporaryRoot(t);
  const first = await exportPlants({ projectId, readTime, backupRoot, read: readerFor([]) });
  const before = await fs.readFile(path.join(first.directory, 'plants.json'));
  const second = await exportPlants({ projectId, readTime, backupRoot, read: readerFor([document('new')]) });
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(await fs.readFile(path.join(first.directory, 'plants.json')), before);
  assert.equal((await verifyBackup(first.directory)).documentCount, 0);
  assert.deepEqual(JSON.parse(before.toString()).documents, []);
});

test('failed reads, duplicates, repeated tokens, wrong resources and count mismatches never publish success', async (t) => {
  const backupRoot = await temporaryRoot(t);
  const reads = [
    async () => { throw new Error('private SDK error'); },
    readerFor([document('same'), document('same')]),
    readerFor([{ ...document('one'), name: 'projects/other/databases/(default)/documents/plants/one' }]),
    async () => ({ nextPageToken: 'repeated' }),
    async (kind) => kind === 'list' ? { documents: [document('one')] } : count(2),
  ];
  for (const read of reads) await assert.rejects(exportPlants({ projectId, readTime, backupRoot, read }));
  for (const run of await fs.readdir(backupRoot)) {
    const files = await fs.readdir(path.join(backupRoot, run));
    assert.deepEqual(files, ['plants.json.partial']);
  }
});

test('offline verifier rejects changed bytes, truncation, invalid JSON and missing manifests', async (t) => {
  const backupRoot = await temporaryRoot(t);
  const result = await exportPlants({ projectId, readTime, backupRoot, read: readerFor([document('one')]) });
  const output = path.join(result.directory, 'plants.json');
  const text = await fs.readFile(output, 'utf8');
  await fs.writeFile(output, text.replace('"id":"one"', '"id":"two"'));
  await assert.rejects(verifyBackup(result.directory));
  await fs.writeFile(output, text.replace(readTime, '2026-11-20T12:00:00.000000000Z'));
  await assert.rejects(verifyBackup(result.directory));
  await fs.writeFile(output, text.slice(0, -10));
  await assert.rejects(inspectBackup(output));
  await fs.writeFile(output, `${text}{}\n`);
  await assert.rejects(inspectBackup(output));
  await fs.writeFile(output, text);
  await fs.unlink(path.join(result.directory, 'integrity.json'));
  await assert.rejects(verifyBackup(result.directory));
});

test('CLI hides secrets from errors and refuses missing/mismatched project before any read', () => {
  const script = path.resolve(__dirname, '../../scripts/backup-firestore.cjs');
  const secret = 'CONFIDENTIAL_TEST_VALUE';
  for (const args of [[], ['--project', projectId]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, FIREBASE_PROJECT_ID: secret, FIREBASE_PRIVATE_KEY: secret },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('Backup failed'));
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stderr.includes(' at '), false);
  }
});
