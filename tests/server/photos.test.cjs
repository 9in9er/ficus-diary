const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createPhotoService, createHandler } = require('../../server/photos.cjs');
const storage = require('../../server/storage.cjs');

function fixture(initial = {}) {
  const records = new Map(Object.entries(structuredClone(initial)));
  const snapshot = (ref) => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const db = {
    collection: (name) => ({ doc: (id) => {
      const ref = { id, path: `${name}/${id}` };
      ref.get = async () => snapshot(ref);
      ref.set = async (value) => records.set(ref.path, structuredClone(value));
      return ref;
    } }),
    runTransaction: async (callback) => {
      const operations = [];
      const result = await callback({ get: async (ref) => snapshot(ref),
        create: (ref, value) => operations.push(() => records.set(ref.path, structuredClone(value))),
        update: (ref, value) => operations.push(() => records.set(ref.path, { ...records.get(ref.path), ...structuredClone(value) })),
        delete: (ref) => operations.push(() => records.delete(ref.path)),
      });
      operations.forEach((apply) => apply());
      return result;
    },
  };
  const files = { ...storage,
    signUpload: mock.fn(async () => 'https://storage.invalid/temporary-upload'),
    readUrl: mock.fn(async () => 'https://storage.invalid/temporary-read'),
    validateUpload: mock.fn(async () => Buffer.from('validated-webp')),
    storePhoto: mock.fn(async () => `${storage.plantPrefix('owner', 'plant-1')}photos/12345678-1234-1234-1234-123456789abc.webp`),
    deletePlantFiles: mock.fn(async () => {}),
  };
  return { records, db, files, service: createPhotoService({ db, files }) };
}
const legacy = { userId: 'owner', name: 'Ficus', photo: 'data:image/jpeg;base64,bGVnYWN5', deletedAt: null };
const upload = { action: 'upload', plantId: 'plant-1', size: 100 };
const fields = { name: 'New name', acquiredAt: '2026-11-19' };

test('denies other users read/upload/commit/delete without touching storage', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  const ticket = await f.service('owner', upload);
  for (const action of ['read', 'upload', 'commit', 'delete']) {
    const service = createPhotoService({ db: f.db, files: f.files, deletionEnabled: true });
    await assert.rejects(service('intruder', { ...upload, action, uploadId: ticket.uploadId, fields }), { status: 403 });
  }
  assert.equal(f.files.readUrl.mock.callCount(), 0);
  assert.equal(f.files.validateUpload.mock.callCount(), 0);
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
});

test('requires authentication, verifies token revocation and rejects malformed requests', async () => {
  const f = fixture();
  const verifyIdToken = mock.fn(async () => ({ uid: 'owner' }));
  const handler = createHandler({ getServices: () => ({ db: f.db, auth: { verifyIdToken } }), files: f.files });
  const run = async (req) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res); return res;
  };
  assert.equal((await run({ method: 'GET' })).code, 405);
  assert.equal((await run({ method: 'POST', headers: {}, body: upload })).code, 401);
  assert.equal(verifyIdToken.mock.callCount(), 0);
  assert.equal((await run({ method: 'POST', headers: { authorization: 'Bearer test-token' }, body: '{broken' })).code, 400);
  assert.deepEqual(verifyIdToken.mock.calls[0].arguments, ['test-token', true]);
  verifyIdToken.mock.mockImplementation(async () => { throw new Error('expired'); });
  assert.equal((await run({ method: 'POST', headers: { authorization: 'Bearer expired' }, body: upload })).code, 401);
});

test('uploads a new plant atomically and retries commit idempotently', async () => {
  const f = fixture();
  const ticket = await f.service('owner', { ...upload, creating: true });
  assert.equal(f.records.has('plants/plant-1'), false);
  const body = { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields };
  const result = await f.service('owner', body);
  const plant = f.records.get('plants/plant-1');
  assert.equal(plant.photoKey, result.photoKey);
  assert.equal(plant.userId, 'owner');
  assert.equal(plant.name, fields.name);
  assert.equal('photo' in plant, false);
  assert.deepEqual(await f.service('owner', body), result);
  assert.equal(f.files.storePhoto.mock.callCount(), 1);
});

test('replacement preserves base64 and never deletes the old file', async () => {
  const oldKey = `${storage.plantPrefix('owner', 'plant-1')}photos/00000000-0000-0000-0000-000000000000.webp`;
  const f = fixture({ 'plants/plant-1': { ...legacy, photoKey: oldKey } });
  const ticket = await f.service('owner', upload);
  const body = { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields };
  f.files.validateUpload.mock.mockImplementationOnce(async () => { throw new Error('download failed'); });
  await assert.rejects(f.service('owner', body));
  assert.equal(f.records.get('plants/plant-1').photoKey, oldKey);
  await f.service('owner', body);
  assert.equal(f.records.get('plants/plant-1').photo, legacy.photo);
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
});

test('failed Firestore commit keeps previous photo and supports retry', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  const ticket = await f.service('owner', upload);
  const body = { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields };
  const runTransaction = f.db.runTransaction;
  f.db.runTransaction = async () => { throw new Error('Firestore offline'); };
  await assert.rejects(f.service('owner', body));
  assert.deepEqual(f.records.get('plants/plant-1'), legacy);
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
  f.db.runTransaction = runTransaction;
  await f.service('owner', body);
  assert.ok(f.records.get('plants/plant-1').photoKey);
});

test('key-only wishlist replacement keeps wishlist status and never recreates legacy photo', async () => {
  const oldKey = `${storage.plantPrefix('owner', 'plant-1')}photos/00000000-0000-0000-0000-000000000000.webp`;
  const original = { userId: 'owner', name: 'Wish', isWishlisted: true, photoKey: oldKey,
    deletedAt: null, description: 'old', price: '', links: [] };
  const f = fixture({ 'plants/plant-1': original });
  const read = await f.service('owner', { action: 'read', plantId: 'plant-1' });
  assert.ok(read.url);
  const ticket = await f.service('owner', upload);
  const wishFields = { name: 'Updated wish', description: 'new', price: '100', links: ['https://example.invalid/plant'] };
  const result = await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId,
    fields: wishFields, isWishlisted: false }); // Existing documents determine their own list.
  assert.deepEqual(f.records.get('plants/plant-1'), { ...original, ...wishFields, photoKey: result.photoKey });
  assert.equal(Object.hasOwn(f.records.get('plants/plant-1'), 'photo'), false);
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
});

test('rejects invalid sizes, expired tickets, trashed plants and concurrent photo edits', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  for (const size of [0, -1, 5.5, storage.MAX_PHOTO_BYTES + 1]) await assert.rejects(f.service('owner', { ...upload, size }), { status: 400 });
  const ticket = await f.service('owner', upload);
  const body = { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields };
  f.records.get(`_photoUploads/${ticket.uploadId}`).expiresAt = 0;
  await assert.rejects(f.service('owner', body), { status: 410 });
  f.records.get(`_photoUploads/${ticket.uploadId}`).expiresAt = Date.now() + 10000;
  f.records.get('plants/plant-1').photoKey = 'changed';
  await assert.rejects(f.service('owner', body), { status: 409 });
  f.records.get('plants/plant-1').deletedAt = new Date().toISOString();
  await assert.rejects(f.service('owner', upload), { status: 409 });
});

test('read signs only the server-stored owned key and supports legacy photos', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  assert.deepEqual(await f.service('owner', { action: 'read', plantId: 'plant-1' }), { url: null });
  f.records.get('plants/plant-1').photoKey = 'plants/another-user/photo.webp';
  await assert.rejects(f.service('owner', { action: 'read', plantId: 'plant-1' }), { status: 409 });
  const ticket = await f.service('owner', upload);
  const result = await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields });
  await f.service('owner', { action: 'read', plantId: 'plant-1', photoKey: 'attacker-supplied-key' });
  assert.equal(f.files.readUrl.mock.calls[0].arguments[0], result.photoKey);
});

test('deletion is disabled by default; enabled deletion requires trash and locks retries on storage failure', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  const body = { action: 'delete', plantId: 'plant-1' };
  await assert.rejects(f.service('owner', body), { status: 409 });
  const service = createPhotoService({ db: f.db, files: f.files, deletionEnabled: true });
  await assert.rejects(service('owner', body), { status: 409 });
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
  f.records.get('plants/plant-1').deletedAt = '2026-11-19T00:00:00.000Z';
  f.files.deletePlantFiles.mock.mockImplementationOnce(async () => { throw new Error('storage unavailable'); });
  await assert.rejects(service('owner', body));
  assert.equal(f.records.get('plants/plant-1')._photoDeleting, true);
  await assert.rejects(service('owner', upload), { status: 409 });
  await service('owner', body);
  assert.equal(f.records.has('plants/plant-1'), false);
  await service('owner', body); // Idempotent after a lost response.
});

module.exports = { fixture };

test('release handler blocks deletion even if Vercel flag is accidentally true, without database/storage writes', async () => {
  const f = fixture({ 'plants/plant-1': { ...legacy, deletedAt: '2026-11-20' } });
  const previous = process.env.ENABLE_PERMANENT_PLANT_DELETE;
  try {
    const handler = createHandler({ getServices: () => ({ db: f.db,
      auth: { verifyIdToken: async () => ({ uid: 'owner' }) } }), files: f.files });
    for (const value of [undefined, 'false', 'true']) {
      if (value === undefined) delete process.env.ENABLE_PERMANENT_PLANT_DELETE;
      else process.env.ENABLE_PERMANENT_PLANT_DELETE = value;
      const before = structuredClone([...f.records]);
      const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ method: 'POST', headers: { authorization: 'Bearer test-token' },
        body: { action: 'delete', plantId: 'plant-1' } }, res);
      assert.equal(res.code, 409);
      assert.match(res.body.error, /отключено/);
      assert.deepEqual([...f.records], before);
      assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
    }
  } finally {
    if (previous === undefined) delete process.env.ENABLE_PERMANENT_PLANT_DELETE;
    else process.env.ENABLE_PERMANENT_PLANT_DELETE = previous;
  }
});
