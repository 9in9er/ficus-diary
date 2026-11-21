const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { spawnSync } = require('node:child_process');
const { TARGETS, FIELDS, parseArgs, readCurrent, counts, diagnose, inspectLegacyPhoto } = require('../../scripts/diagnose-photo-migration.cjs');

const project = 'my-plants-app-8f6fc';
const beforeTime = '2026-11-19T21:43:13.534500000Z';
const nowTime = '2026-11-20T10:00:00.000000000Z';
const string = (value) => ({ stringValue: value });
const doc = (id, fields) => ({ name: `projects/${project}/databases/(default)/documents/plants/${id}`,
  createTime: '2026-11-17T10:00:00Z', updateTime: '2026-11-17T11:00:00Z', fields });
const dataset = (entries, readTime = beforeTime) => ({ readTime, documents: new Map(entries) });
const source = async () => 'data:image/png;base64,' + (await sharp({ create: {
  width: 8, height: 8, channels: 3, background: 'green',
} }).png().toBuffer()).toString('base64');

test('diagnosis CLI requires explicit project/backup and rejects migration/cleanup flags', () => {
  const args = ['--project', project, '--backup', 'backups/test'];
  assert.deepEqual(parseArgs(args), { project, backup: 'backups/test' });
  assert.equal(parseArgs([...args, '--offline']).offline, true);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const extra of [['--apply'], ['--cleanup'], ['--project', project], ['--offline', '--offline'], ['--user', 'uid']]) {
    assert.throws(() => parseArgs([...args, ...extra]));
  }
  assert.throws(() => parseArgs(['--project', '../outside', '--backup', 'backup']));
  assert.throws(() => parseArgs(['--project', project]));
});

test('live transport only executes a projected read query to the fixed Firestore endpoint', async () => {
  const calls = [];
  const result = await readCurrent({ project, credential: { getAccessToken: async () => ({ access_token: 'fake-token' }) },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => [{ readTime: nowTime, document: doc(TARGETS[0], { userId: string('private-uid') }) }] };
    } });
  assert.equal(result.documents.size, 1);
  assert.equal(result.readTime, nowTime);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.Authorization, 'Bearer fake-token');
  const body = JSON.parse(options.body);
  assert.deepEqual(Object.keys(body), ['structuredQuery']);
  assert.deepEqual(body.structuredQuery.from, [{ collectionId: 'plants' }]);
  assert.deepEqual(body.structuredQuery.select.fields.map((field) => field.fieldPath), FIELDS);
  assert.ok(!options.body.includes('update') && !options.body.includes('transaction'));
});

test('failed/partial/duplicate/wrong-project reads cannot produce a successful comparison', async () => {
  const base = { project, credential: { getAccessToken: async () => ({ access_token: 'fake' }) } };
  for (const response of [
    { ok: false, status: 403 },
    { ok: false, status: 500 },
    { ok: true, json: async () => ({ error: 'sensitive' }) },
    { ok: true, json: async () => [] },
    { ok: true, json: async () => [{ readTime: nowTime }, { readTime: beforeTime }] },
    { ok: true, json: async () => [{ readTime: nowTime, error: 'sensitive' }] },
    { ok: true, json: async () => [{ readTime: nowTime, document: { ...doc('a', {}), name: 'projects/other/documents/a' } }] },
    { ok: true, json: async () => [1, 2].map(() => ({ readTime: nowTime, document: doc('a', {}) })) },
  ]) await assert.rejects(readCurrent({ ...base, fetchImpl: async () => response }));
});

test('different owner scope is visible without printing UID/base64/keys/names, and does not invent run history', async () => {
  const photo = await source();
  const primary = doc('primary', { userId: string('PRIVATE_UID_A'), photo: string(photo) });
  const targetA = doc(TARGETS[0], { userId: string('PRIVATE_UID_B'), deletedAt: { nullValue: null },
    photo: string(photo), name: string('PRIVATE_NAME') });
  const targetB = doc(TARGETS[1], { userId: string('PRIVATE_UID_C'), photo: string(photo) });
  const backup = dataset([['primary', primary], [TARGETS[0], targetA], [TARGETS[1], targetB]]);
  const current = dataset([['primary', { ...primary, fields: { ...primary.fields, photoKey: string('PRIVATE_OBJECT_KEY') } }],
    [TARGETS[0], targetA], [TARGETS[1], targetB]], nowTime);
  const report = await diagnose({ project, backup, current, migrationUser: 'PRIVATE_UID_A' });
  const output = JSON.stringify(report);
  for (const value of ['PRIVATE_UID_A', 'PRIVATE_UID_B', 'PRIVATE_UID_C', 'PRIVATE_NAME', 'PRIVATE_OBJECT_KEY', photo]) {
    assert.ok(!output.includes(value));
  }
  assert.equal(report.executionHistoryAvailable, false);
  assert.equal(report.migrationOwnerKnown, true);
  assert.equal(report.migrationOwner, 'owner-1');
  assert.equal(report.targets[0].current.owner, 'owner-2');
  assert.equal(report.targets[1].current.owner, 'owner-3');
  for (const target of report.targets) {
    assert.deepEqual(target.changedFieldsSinceBackup, []);
    assert.equal(target.migrationOwnerMatchNow, false);
    assert.equal(target.updatedAfterBackup, false);
    assert.equal(target.suitableForTargetedMigrationNow, true);
  }
  const unknown = await diagnose({ project, backup, current });
  assert.equal(unknown.migrationOwnerKnown, false);
  assert.equal(unknown.targets[0].migrationOwnerMatchNow, null);
});

test('trash totals distinguish owner scope from real transitions, deletion and restore', async () => {
  const base = { userId: string('private-uid'), photo: string('data:image/png;base64,AA==') };
  const trash = (time) => ({ ...base, deletedAt: string(time) });
  const backup = dataset([['entered', doc('entered', base)], ['restored', doc('restored', trash(beforeTime))],
    ['removed', doc('removed', trash(beforeTime))], ['changed', doc('changed', trash(beforeTime))]]);
  const current = dataset([['entered', doc('entered', trash(nowTime))], ['restored', doc('restored', base)],
    ['changed', doc('changed', trash(nowTime))], ['new', doc('new', trash(nowTime))]], nowTime);
  const report = await diagnose({ project, backup, current });
  assert.equal(report.baseline.trashPlants, 3);
  assert.equal(report.current.trashPlants, 3);
  assert.equal(report.trashChanges.netDelta, 0);
  assert.deepEqual(report.trashChanges.enteredTrash.map((item) => item.plantId), ['entered', 'new']);
  assert.deepEqual(report.trashChanges.leftTrash.map((item) => item.plantId), ['restored']);
  assert.deepEqual(report.trashChanges.removedTrashDocuments.map((item) => item.plantId), ['removed']);
  assert.deepEqual(report.trashChanges.changedDeletionTimestamp.map((item) => item.plantId), ['changed']);
});

test('null/absent/false states, changed target fields and keyed document without old photo remain distinct', async () => {
  const photo = await source();
  const before = doc(TARGETS[0], { userId: string('private-owner'), photo: string(photo), deletedAt: string(beforeTime) });
  const now = { ...before, updateTime: nowTime, fields: { ...before.fields, deletedAt: { nullValue: null },
    _photoDeleting: { booleanValue: true } } };
  const keyOnly = doc('key-only', { userId: string('private-owner'), photoKey: string('private-key') });
  const backup = dataset([[TARGETS[0], before], ['key-only', keyOnly]]);
  const current = dataset([[TARGETS[0], now], ['key-only', keyOnly]], nowTime);
  const report = await diagnose({ project, backup, current });
  assert.equal(report.targets[0].backupSelection, 'TRASH');
  assert.equal(report.targets[0].currentSelection, 'PHOTO_DELETION_IN_PROGRESS');
  assert.equal(report.targets[0].suitableForTargetedMigrationNow, false);
  assert.deepEqual(report.targets[0].changedFieldsSinceBackup, ['deletedAt', '_photoDeleting']);
  assert.equal(report.targets[1].current.exists, false);
  assert.equal(report.targets[1].suitableForTargetedMigrationNow, false);
  assert.deepEqual(report.keyedDocumentsWithoutPhotoField, [{ plantId: 'key-only', owner: 'owner-1',
    documentExistedInBackup: true, photoFieldPresentInBackup: false, photoKeyPresentInBackup: true }]);
  assert.equal(counts(current.documents).photoAndPhotoKeyFields, 0);
});

test('local photo compatibility checks never call migration/storage and reject unsupported or broken images', async () => {
  assert.equal((await inspectLegacyPhoto(doc('a', { photo: string(await source()) }))).valid, true);
  assert.deepEqual(await inspectLegacyPhoto(doc('a', { photo: string('data:image/svg+xml;base64,AA==') })),
    { valid: false, code: 'UNSUPPORTED_LEGACY_PHOTO' });
  assert.deepEqual(await inspectLegacyPhoto(doc('a', { photo: string('data:image/png;base64,AA==') })),
    { valid: false, code: 'LEGACY_DECODE_FAILED' });
  assert.deepEqual(await inspectLegacyPhoto(doc('a', {
    photo: string('data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')),
  })), { valid: false, code: 'INVALID_LEGACY_SIZE' });
});

test('CLI diagnostic never prints raw invalid arguments or initialization errors', () => {
  const secret = 'data:image/png;base64,PRIVATE_SECRET';
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const result = spawnSync(process.execPath, ['scripts/diagnose-photo-migration.cjs', '--project', secret], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes('Error:'));
});
