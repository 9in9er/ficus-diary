const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { parseArgs, migratePlant, convertLegacyPhoto } = require('../../scripts/migrate-photos.cjs');

test('migration defaults to dry-run and apply requires explicit single plant and project/user', () => {
  assert.equal(parseArgs(['--project', 'test', '--user', 'owner']).apply, false);
  assert.throws(() => parseArgs(['--apply', '--project', 'test', '--user', 'owner']), /--plant/);
  assert.throws(() => parseArgs(['--apply', '--plant', 'plant-1']), /--project/);
  assert.throws(() => parseArgs(['--project', 'test', '--user', 'owner', '--apply', '--dry-run', '--plant', 'plant-1']));
});

test('dry-run converts locally without any cloud writes, apply preserves original base64', async () => {
  const original = { userId: 'owner', photo: 'data:image/png;base64,bGVnYWN5' };
  const ref = {};
  const snapshot = { exists: true, id: 'plant-1', ref, data: () => ({ ...original }) };
  const update = mock.fn();
  const files = { storePhoto: mock.fn(async () => 'new-key') };
  const db = { runTransaction: mock.fn(async (cb) => cb({ get: async () => snapshot, update })) };
  const convert = mock.fn(async () => Buffer.from('webp'));
  const input = { db, snapshot, userId: 'owner', files, convert };
  assert.equal((await migratePlant(input)).status, 'dry-run');
  assert.equal(files.storePhoto.mock.callCount(), 0);
  assert.equal(db.runTransaction.mock.callCount(), 0);
  assert.equal((await migratePlant({ ...input, apply: true })).status, 'migrated');
  assert.deepEqual(update.mock.calls[0].arguments, [ref, { photoKey: 'new-key' }]);
  assert.equal(snapshot.data().photo, original.photo);
  await assert.rejects(migratePlant({ ...input, userId: 'intruder', apply: true }), /Owner/);
});

test('migration skips already migrated and trashed plants', async () => {
  for (const data of [{ photoKey: 'exists' }, { deletedAt: '2026-11-19' }, { _photoDeleting: true }]) {
    const result = await migratePlant({ db: {}, snapshot: { exists: true, data: () => ({ userId: 'owner', photo: 'data:image/png;base64,AA==', ...data }) }, userId: 'owner', apply: true, files: {} });
    assert.equal(result.status, 'skipped');
  }
});

test('legacy conversion outputs WebP <=1600px without enlarging small images', async () => {
  for (const [width, height, expected] of [[3000, 2000, 1600], [200, 400, 400]]) {
    const source = await sharp({ create: { width, height, channels: 3, background: '#297c41' } }).png().toBuffer();
    const result = await convertLegacyPhoto(`data:image/png;base64,${source.toString('base64')}`);
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(Math.max(metadata.width, metadata.height), expected);
  }
  await assert.rejects(convertLegacyPhoto('data:text/html;base64,AA=='));
});
