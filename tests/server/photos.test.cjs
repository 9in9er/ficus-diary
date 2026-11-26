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
    storePhotoVersions: mock.fn(async () => ({
      photoKey: `${storage.plantPrefix('owner', 'plant-1')}photos/12345678-1234-1234-1234-123456789abc.webp`,
      photoThumbKey: `${storage.plantPrefix('owner', 'plant-1')}photos/22345678-1234-1234-1234-123456789abc.webp`,
    })),
    deletePhotoVersions: mock.fn(async () => {}),
    deletePlantFiles: mock.fn(async () => {}),
  };
  return { records, db, files, service: createPhotoService({ db, files }) };
}
const legacy = { userId: 'owner', name: 'Ficus', photo: 'data:image/jpeg;base64,bGVnYWN5', deletedAt: null };
const upload = { action: 'upload', plantId: 'plant-1', size: 100 };
const fields = { name: 'New name', acquiredAt: '2026-11-19' };

test('photo API keeps purchase and sale metadata through link and uploaded-photo edits', async () => {
  const f = fixture({ 'plants/plant-1': { ...legacy, soldAt: '2026-11-25', salePrice: 100,
    notes: ['keep'], wateringLog: ['keep'], photoThumbKey: null } });
  const details = { ...fields, price: 0, soldAt: '2026-11-26', salePrice: 0 };
  await f.service('owner', { action: 'link', plantId: 'plant-1', photo: 'https://example.com/photo.jpg', fields: details });
  assert.deepEqual(f.records.get('plants/plant-1'), { ...legacy, ...details,
    photo: 'https://example.com/photo.jpg', notes: ['keep'], wateringLog: ['keep'], photoKey: null, photoThumbKey: null });
  const ticket = await f.service('owner', upload);
  await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId,
    fields: { ...details, price: 850, salePrice: 1200 } });
  assert.equal(f.records.get('plants/plant-1').price, 850);
  assert.equal(f.records.get('plants/plant-1').salePrice, 1200);
  assert.deepEqual(f.records.get('plants/plant-1').notes, ['keep']);
});

test('photo API rejects invalid monetary and sale metadata before storage writes', async () => {
  for (const patch of [{ price: -1 }, { price: '850' }, { price: Infinity },
    { soldAt: '2026-11-26', salePrice: -1 }, { soldAt: '2026-02-30', salePrice: 0 },
    { soldAt: '0000-01-01', salePrice: 0 }, { soldAt: '2026-11-26' }, { salePrice: 0 }]) {
    const f = fixture({ 'plants/plant-1': legacy });
    await assert.rejects(f.service('owner', { action: 'link', plantId: 'plant-1', photo: 'https://example.com/photo.jpg', fields: { ...fields, ...patch } }), { status: 400 });
    assert.deepEqual(f.records.get('plants/plant-1'), legacy);
    assert.equal(f.files.storePhotoVersions.mock.callCount(), 0);
  }
});

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
  assert.equal(plant.photoThumbKey, result.photoThumbKey);
  assert.notEqual(plant.photoKey, plant.photoThumbKey);
  assert.equal(plant.userId, 'owner');
  assert.equal(plant.name, fields.name);
  assert.equal('photo' in plant, false);
  assert.deepEqual(await f.service('owner', body), result);
  assert.equal(f.files.storePhotoVersions.mock.callCount(), 1);
});

test('replacement preserves base64 and never deletes the old file', async () => {
  const oldKey = `${storage.plantPrefix('owner', 'plant-1')}photos/00000000-0000-0000-0000-000000000000.webp`;
  const oldThumbKey = oldKey.replace('00000000-', '10000000-');
  const f = fixture({ 'plants/plant-1': { ...legacy, photoKey: oldKey, photoThumbKey: oldThumbKey } });
  const ticket = await f.service('owner', upload);
  const body = { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields };
  f.files.validateUpload.mock.mockImplementationOnce(async () => { throw new Error('download failed'); });
  await assert.rejects(f.service('owner', body));
  assert.equal(f.records.get('plants/plant-1').photoKey, oldKey);
  await f.service('owner', body);
  assert.equal(f.records.get('plants/plant-1').photo, legacy.photo);
  assert.notEqual(f.records.get('plants/plant-1').photoThumbKey, oldThumbKey);
  assert.equal(f.files.deletePhotoVersions.mock.callCount(), 0);
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
});

test('existing migrated photos support owner reads, replacement and permanent deletion', async (t) => {
  // Fixed historical key, including a non-RFC UUID variant, must remain usable without migration writers.
  const filename = 'b3d652ac-7074-4921-6e0d-7c6722eeac98.webp';
  const oldKey = `${storage.plantPrefix('owner', 'plant-1')}photos/${filename}`;
  const original = { userId: 'owner', name: 'Migrated ficus', photoKey: oldKey, deletedAt: null };
  const f = fixture({ 'plants/plant-1': original });
  const read = { action: 'read', plantId: 'plant-1' };
  assert.ok((await f.service('owner', read)).url);
  assert.deepEqual(f.files.readUrl.mock.calls[0].arguments, [oldKey]);
  await assert.rejects(f.service('intruder', read), { status: 403 });
  assert.equal(f.files.readUrl.mock.callCount(), 1);

  const ticket = await f.service('owner', upload);
  assert.equal(f.records.get(`_photoUploads/${ticket.uploadId}`).previousKey, oldKey);
  const replacement = await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields });
  assert.notEqual(replacement.photoKey, oldKey);
  assert.equal(f.records.get('plants/plant-1').photoKey, replacement.photoKey);
  assert.equal(Object.hasOwn(f.records.get('plants/plant-1'), 'photo'), false);
  assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);

  for (const photoKey of [oldKey, replacement.photoKey]) {
    await t.test(`deletes trashed plant with ${photoKey === oldKey ? 'migrated' : 'replacement'} key`, async () => {
      const trashed = fixture({ 'plants/plant-1': { ...original, photoKey, deletedAt: '2026-11-20' } });
      const service = createPhotoService({ db: trashed.db, files: trashed.files, deletionEnabled: true });
      const body = { action: 'delete', plantId: 'plant-1' };
      await assert.rejects(service('intruder', body), { status: 403 });
      assert.equal(trashed.files.deletePlantFiles.mock.callCount(), 0);
      assert.deepEqual(await service('owner', body), { deleted: true });
      assert.deepEqual(trashed.files.deletePlantFiles.mock.calls[0].arguments, ['owner', 'plant-1']);
      assert.equal(trashed.records.has('plants/plant-1'), false);
    });
  }

  for (const prefix of [storage.plantPrefix('intruder', 'plant-1'), storage.plantPrefix('owner', 'plant-2')]) {
    const invalid = fixture({ 'plants/plant-1': { ...original, photoKey: `${prefix}photos/${filename}`, deletedAt: '2026-11-20' } });
    const service = createPhotoService({ db: invalid.db, files: invalid.files, deletionEnabled: true });
    await assert.rejects(service('owner', read), { status: 409 });
    await assert.rejects(service('owner', { action: 'delete', plantId: 'plant-1' }), { status: 409 });
    assert.equal(invalid.files.readUrl.mock.callCount(), 0);
    assert.equal(invalid.files.deletePlantFiles.mock.callCount(), 0);
    assert.equal(invalid.records.get('plants/plant-1')._photoDeleting, undefined);
  }
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
  assert.deepEqual(f.records.get('plants/plant-1'), { ...original, ...wishFields, ...result });
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

test('thumbnail reads use the stored thumbnail, fallback for old records, and never accept client keys', async () => {
  const f = fixture();
  const ticket = await f.service('owner', { ...upload, creating: true });
  const keys = await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields });
  for (const [variant, expected] of [['original', keys.photoKey], ['thumbnail', keys.photoThumbKey]]) {
    await f.service('owner', { action: 'read', plantId: 'plant-1', variant,
      photoKey: 'attacker-key', photoThumbKey: 'attacker-thumb' });
    assert.equal(f.files.readUrl.mock.calls.at(-1).arguments[0], expected);
    await assert.rejects(f.service('intruder', { action: 'read', plantId: 'plant-1', variant }), { status: 403 });
  }
  delete f.records.get('plants/plant-1').photoThumbKey;
  await f.service('owner', { action: 'read', plantId: 'plant-1', variant: 'thumbnail' });
  assert.equal(f.files.readUrl.mock.calls.at(-1).arguments[0], keys.photoKey);
  f.records.get('plants/plant-1').photoThumbKey = 'plants/foreign/photos/thumbnail.webp';
  await assert.rejects(f.service('owner', { action: 'read', plantId: 'plant-1', variant: 'thumbnail' }), { status: 409 });
  for (const variant of ['../../key', null, {}, 'full']) {
    await assert.rejects(f.service('owner', { action: 'read', plantId: 'plant-1', variant }), { status: 400 });
  }
});

test('both variants require a valid Firebase token before reading any storage key', async () => {
  const f = fixture();
  const verifyIdToken = mock.fn(async () => { throw new Error('expired'); });
  const handler = createHandler({ getServices: () => ({ db: f.db, auth: { verifyIdToken } }), files: f.files });
  for (const variant of ['original', 'thumbnail']) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json() { return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer expired' },
      body: { action: 'read', plantId: 'plant-1', variant } }, res);
    assert.equal(res.code, 401);
  }
  assert.equal(f.files.readUrl.mock.callCount(), 0);
});

test('thumbnail creation/storage failures leave both existing keys and legacy data untouched', async () => {
  for (const creating of [false, true]) {
    const f = fixture(creating ? {} : { 'plants/plant-1': legacy });
    const ticket = await f.service('owner', { ...upload, creating });
    f.files.storePhotoVersions.mock.mockImplementationOnce(async () => { throw new Error('thumbnail upload failed'); });
    await assert.rejects(f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields }));
    assert.deepEqual(f.records.get('plants/plant-1'), creating ? undefined : legacy);
    assert.equal(f.records.get(`_photoUploads/${ticket.uploadId}`).committedKey, undefined);
    // A later retry can publish both fields together.
    const result = await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields });
    assert.equal(f.records.get('plants/plant-1').photoThumbKey, result.photoThumbKey);
  }
});

test('a definite transaction conflict cleans only the new pair and does not delete concurrent replacements', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  const ticket = await f.service('owner', upload);
  const store = f.files.storePhotoVersions;
  const keys = await store();
  store.mock.mockImplementationOnce(async () => {
    f.records.get('plants/plant-1').photoKey = 'concurrent-replacement';
    return keys;
  });
  await assert.rejects(f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields }), { status: 409 });
  assert.equal(f.records.get('plants/plant-1').photoKey, 'concurrent-replacement');
  assert.deepEqual(f.files.deletePhotoVersions.mock.calls[0].arguments, ['owner', 'plant-1', keys]);
});

test('lost transaction responses preserve the published pair and retry returns both keys without reupload', async () => {
  const f = fixture();
  const ticket = await f.service('owner', { ...upload, creating: true });
  const runTransaction = f.db.runTransaction;
  f.db.runTransaction = async (callback) => { await runTransaction(callback); throw new Error('response lost'); };
  const body = { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields };
  await assert.rejects(f.service('owner', body));
  assert.equal(f.files.deletePhotoVersions.mock.callCount(), 0);
  f.db.runTransaction = runTransaction;
  const result = await f.service('owner', body);
  assert.deepEqual(result, { photoKey: f.records.get('plants/plant-1').photoKey,
    photoThumbKey: f.records.get('plants/plant-1').photoThumbKey });
  assert.equal(f.files.storePhotoVersions.mock.callCount(), 1);
});

test('old committed tickets without a thumbnail remain readable and retryable', async () => {
  const f = fixture();
  const ticket = await f.service('owner', { ...upload, creating: true });
  const photoKey = `${storage.plantPrefix('owner', 'plant-1')}photos/12345678-1234-1234-1234-123456789abc.webp`;
  f.records.set('plants/plant-1', { ...legacy, photoKey });
  f.records.get(`_photoUploads/${ticket.uploadId}`).committedKey = photoKey;
  assert.deepEqual(await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields }), { photoKey });
  assert.equal(f.files.storePhotoVersions.mock.callCount(), 0);
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

test('external URLs create collection and wishlist records without any storage calls', async () => {
  for (const isWishlisted of [false, true]) {
    const f = fixture();
    const photo = 'https://example.com/image?id=123&format=webp';
    const linkFields = isWishlisted ? { name: 'Wish', description: '', price: '', links: [] } : fields;
    assert.deepEqual(await f.service('owner', { action: 'link', plantId: 'plant-1', creating: true,
      isWishlisted, photo: ` ${photo} `, fields: linkFields }), { photo });
    const saved = f.records.get('plants/plant-1');
    assert.equal(saved.photo, photo);
    assert.equal(saved.userId, 'owner');
    assert.equal(saved.isWishlisted, isWishlisted);
    assert.equal('photoKey' in saved, false);
    for (const method of ['signUpload', 'readUrl', 'validateUpload', 'storePhotoVersions', 'deletePhotoVersions', 'deletePlantFiles']) {
      assert.equal(f.files[method].mock.callCount(), 0);
    }
  }
});

test('replaces stored and legacy photos with a URL, then permits replacing the URL with a file', async () => {
  const oldKey = `${storage.plantPrefix('owner', 'plant-1')}photos/00000000-0000-0000-0000-000000000000.webp`;
  for (const previous of [legacy, { ...legacy, photoKey: oldKey, photoThumbKey: oldKey.replace('00000000-', '10000000-') }]) {
    const f = fixture({ 'plants/plant-1': previous });
    const photo = 'http://example.com/image/123';
    await f.service('owner', { action: 'link', plantId: 'plant-1', photo, fields });
    assert.equal(f.records.get('plants/plant-1').photo, photo);
    assert.equal(f.records.get('plants/plant-1').photoKey, null);
    assert.equal(f.records.get('plants/plant-1').photoThumbKey, null);
    const ticket = await f.service('owner', upload);
    await f.service('owner', { action: 'commit', plantId: 'plant-1', uploadId: ticket.uploadId, fields });
    assert.ok(f.records.get('plants/plant-1').photoKey);
    assert.ok(f.records.get('plants/plant-1').photoThumbKey);
    assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
  }
});

test('URL updates preserve wishlist details and list membership from the existing record', async () => {
  const f = fixture({ 'plants/plant-1': { ...legacy, isWishlisted: true } });
  const wishFields = { name: 'Wish', description: 'Leaves', price: '500', links: ['https://example.com/shop'] };
  await f.service('owner', { action: 'link', plantId: 'plant-1', photo: 'https://example.com/image', fields: wishFields, isWishlisted: false });
  assert.deepEqual(f.records.get('plants/plant-1'), { ...legacy, ...wishFields,
    isWishlisted: true, photo: 'https://example.com/image', photoKey: null, photoThumbKey: null });
});

test('URL operations reject invalid protocols, ownership violations, deleted plants, and duplicate creates', async () => {
  const f = fixture({ 'plants/plant-1': legacy });
  const body = { action: 'link', plantId: 'plant-1', fields, photo: 'https://example.com/image' };
  for (const photo of ['', null, {}, 'example.com/photo', 'https://', 'ftp://example.com/image', 'data:image/png;base64,AA==', 'javascript:alert(1)']) {
    await assert.rejects(f.service('owner', { ...body, photo }), { status: 400 });
  }
  await assert.rejects(f.service('intruder', body), { status: 403 });
  await assert.rejects(f.service('owner', { ...body, creating: true }), { status: 409 });
  await assert.rejects(f.service('owner', { ...body, plantId: 'missing' }), { status: 404 });
  assert.deepEqual(f.records.get('plants/plant-1'), legacy);
  for (const extra of [{ deletedAt: '2026-11-20' }, { _photoDeleting: true }]) {
    const locked = fixture({ 'plants/plant-1': { ...legacy, ...extra } });
    await assert.rejects(locked.service('owner', body), { status: 409 });
    assert.deepEqual(locked.records.get('plants/plant-1'), { ...legacy, ...extra });
  }
});

test('handler requires exact env opt-in and preserves permanent deletion safeguards', async (t) => {
  const previous = process.env.ENABLE_PERMANENT_PLANT_DELETE;
  const trashed = { ...legacy, deletedAt: '2026-11-20',
    photoKey: `${storage.plantPrefix('owner', 'plant-1')}photos/12345678-1234-1234-1234-123456789abc.webp` };
  const run = async (f, { uid = 'owner', authorization = 'Bearer test-token' } = {}) => {
    const handler = createHandler({ getServices: () => ({ db: f.db,
      auth: { verifyIdToken: async () => ({ uid }) } }), files: f.files });
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: { authorization },
      body: { action: 'delete', plantId: 'plant-1' } }, res);
    return res;
  };
  try {
    for (const value of [undefined, 'false', 'TRUE', '1', ' true', 'true ', '"true"']) {
      await t.test(`blocks deletion with env ${JSON.stringify(value) ?? 'unset'}`, async () => {
        if (value === undefined) delete process.env.ENABLE_PERMANENT_PLANT_DELETE;
        else process.env.ENABLE_PERMANENT_PLANT_DELETE = value;
        const f = fixture({ 'plants/plant-1': trashed });
        const before = structuredClone([...f.records]);
        const res = await run(f);
        assert.equal(res.code, 409);
        assert.match(res.body.error, /отключено/);
        assert.deepEqual([...f.records], before);
        assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
      });
    }

    process.env.ENABLE_PERMANENT_PLANT_DELETE = 'true';
    await t.test('allows the authenticated owner to delete a trashed plant with env true', async () => {
      const f = fixture({ 'plants/plant-1': trashed });
      f.files.deletePlantFiles.mock.mockImplementation(async () => {
        assert.equal(f.records.get('plants/plant-1')._photoDeleting, true);
      });
      const res = await run(f);
      assert.equal(res.code, 200);
      assert.deepEqual(res.body, { deleted: true });
      assert.equal(f.files.deletePlantFiles.mock.callCount(), 1);
      assert.deepEqual(f.files.deletePlantFiles.mock.calls[0].arguments, ['owner', 'plant-1']);
      assert.equal(f.records.has('plants/plant-1'), false);
    });

    for (const { name, plant = trashed, request, status } of [
      { name: 'another user', request: { uid: 'intruder' }, status: 403 },
      { name: 'an active plant', plant: { ...trashed, deletedAt: null }, status: 409 },
      { name: 'an unowned photo key', plant: { ...trashed, photoKey: 'plants/another-user/photo.webp' }, status: 409 },
      { name: 'an unauthenticated request', request: { authorization: null }, status: 401 },
    ]) {
      await t.test(`rejects ${name} with env true without database/storage writes`, async () => {
        const f = fixture({ 'plants/plant-1': plant });
        const before = structuredClone([...f.records]);
        const res = await run(f, request);
        assert.equal(res.code, status);
        assert.deepEqual([...f.records], before);
        assert.equal(f.files.deletePlantFiles.mock.callCount(), 0);
      });
    }
  } finally {
    if (previous === undefined) delete process.env.ENABLE_PERMANENT_PLANT_DELETE;
    else process.env.ENABLE_PERMANENT_PLANT_DELETE = previous;
  }
});
