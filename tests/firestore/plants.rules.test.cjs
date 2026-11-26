const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { collection, doc, addDoc, setDoc, updateDoc, deleteDoc, deleteField,
  getDoc, getDocs, query, where, runTransaction, writeBatch, setLogLevel } = require('firebase/firestore');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createPhotoService } = require('../../server/photos.cjs');
const { plantPrefix, ownsPhotoKey } = require('../../server/storage.cjs');

// Hard fail instead of ever falling back to a real Firebase project or endpoint.
const PROJECT_ID = 'demo-ficus-diary-rules';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  throw new Error('Rules tests require a local FIRESTORE_EMULATOR_HOST. Run npm run test:rules.');
}
if (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== PROJECT_ID) {
  throw new Error('Rules tests must use the isolated demo project. Run npm run test:rules.');
}

const DATE = '2026-11-20T10:00:00.000Z';
const base = () => ({
  name: 'Фикус', acquiredAt: '2026-11-20', wateringLog: [], fertilizingLog: [], notes: [],
  userId: 'alice', createdAt: DATE, pinned: false, hidden: false, deletedAt: null,
});
const wish = () => ({
  name: 'Монстера', description: 'Большие листья', price: '1000 ₽', links: ['https://example.com/plant'],
  isWishlisted: true, userId: 'alice', createdAt: DATE, deletedAt: null, hidden: false, pinned: false,
});
const legacy = () => ({ ...base(), photo: 'data:image/jpeg;base64,bGVnYWN5', historicalField: 'preserve' });
const key = `${plantPrefix('alice', 'plant')}photos/12345678-1234-1234-1234-123456789abc.webp`;
let env;
let adminApp;
let admin;
const client = (uid = 'alice') => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const plantRef = (db = client(), id = 'plant') => doc(db, 'plants', id);
const seed = (value = legacy(), id = 'plant') => admin.collection('plants').doc(id).set(value);

test('a restored legacy plant with no purchase price can be sold for 600 on a past date', async () => {
  const original = { ...legacy(), name: 'Каладиум роузбад 2', deletedAt: DATE,
    photoKey: key, photoThumbKey: key, notes: [{ id: 'note', text: 'Keep history' }] };
  await seed(original);
  await assertSucceeds(updateDoc(plantRef(), { deletedAt: null }));
  await assertSucceeds(updateDoc(plantRef(), { soldAt: '2026-11-23', salePrice: 600, hidden: false, pinned: false }));
  assert.deepEqual((await getDoc(plantRef())).data(), {
    ...original, deletedAt: null, soldAt: '2026-11-23', salePrice: 600,
  });
});

test('sale lifecycle keeps document, all photo keys, notes and care history; trash restores to sold', async () => {
  const original = { ...legacy(), price: 850, photoKey: key, photoThumbKey: key,
    notes: [{ id: 'note', text: 'Keep me' }], wateringLog: [DATE], fertilizingLog: [DATE] };
  await seed(original);
  const ref = plantRef();
  await assertSucceeds(updateDoc(ref, { soldAt: '2026-11-26', salePrice: 0, hidden: false, pinned: false }));
  await assertSucceeds(updateDoc(ref, { price: 0, salePrice: 1200, soldAt: '2026-10-01' }));
  await assertSucceeds(updateDoc(ref, { deletedAt: DATE }));
  await assertFails(updateDoc(ref, { salePrice: 100 }));
  await assertSucceeds(updateDoc(ref, { deletedAt: null }));
  assert.deepEqual((await getDoc(ref)).data(), { ...original, price: 0, soldAt: '2026-10-01', salePrice: 1200 });
  await assertSucceeds(updateDoc(ref, { soldAt: null, salePrice: null }));
  assert.deepEqual((await getDoc(ref)).data(), { ...original, price: 0, soldAt: null, salePrice: null });
});

test('sale validation rejects negative, incomplete, malformed and wishlist sales without weakening ownership or photo locks', async () => {
  for (const patch of [
    { soldAt: '2026-11-26' }, { salePrice: 10 },
    { soldAt: '2026-11-26', salePrice: -1 }, { soldAt: '2026-11-26', salePrice: '10' },
    { soldAt: '2026-13-01', salePrice: 10 }, { soldAt: 'invalid', salePrice: 10 },
    { soldAt: '2026-02-30', salePrice: 0 }, { soldAt: '2026-02-29', salePrice: 0 },
    { soldAt: '0000-01-01', salePrice: 0 }, { soldAt: '2026-04-31', salePrice: 0 },
    { price: -1 }, { price: 'abc' }, { soldAt: null, salePrice: 10 },
  ]) {
    await seed();
    await assertFails(updateDoc(plantRef(), patch));
  }
  const sale = { soldAt: '2026-11-26', salePrice: 0 };
  await seed(wish());
  await assertFails(updateDoc(plantRef(), sale));
  await seed();
  for (const uid of [null, 'bob']) await assertFails(updateDoc(plantRef(client(uid)), sale));
  await seed({ ...legacy(), _photoDeleting: true });
  await assertFails(updateDoc(plantRef(), sale));
  await assertFails(setDoc(plantRef(client(), 'bad-sale'), { ...base(), soldAt: '2026-11-26', salePrice: -1 }));
  await seed();
  await assertSucceeds(updateDoc(plantRef(), { soldAt: '2024-02-29', salePrice: 0 }));
});

test('old wishlist string prices survive acquisition and later sale without migration', async () => {
  await seed(wish());
  await assertSucceeds(updateDoc(plantRef(), { isWishlisted: false, acquiredAt: '2026-11-25' }));
  await assertSucceeds(updateDoc(plantRef(), { soldAt: '2026-11-26', salePrice: 1200 }));
  assert.equal((await getDoc(plantRef())).data().price, '1000 ₽');
});

before(async () => {
  setLogLevel('silent'); // Expected PERMISSION_DENIED cases are asserted below.
  const [hostname, port] = host.split(':');
  env = await initializeTestEnvironment({ projectId: PROJECT_ID,
    firestore: { host: hostname, port: Number(port), rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
  // A real Admin SDK connection to this same local emulator, without credentials.
  adminApp = initializeApp({ projectId: PROJECT_ID }, 'rules-server-integration');
  admin = getFirestore(adminApp);
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => {
  if (admin) await admin.terminate();
  if (adminApp) await deleteApp(adminApp);
  if (env) await env.cleanup();
});

test('addDoc: owner creates ordinary plant and wishlist using current application payloads', async () => {
  const db = client();
  await assertSucceeds(addDoc(collection(db, 'plants'), base()));
  await assertSucceeds(addDoc(collection(db, 'plants'), wish()));
});

test('create accepts optional replanted for both plant kinds, without requiring it on old payloads', async () => {
  const db = client();
  await assertSucceeds(setDoc(plantRef(db, 'plant'), { ...base(), replanted: false }));
  await assertSucceeds(setDoc(plantRef(db, 'wish'), { ...wish(), replanted: true }));
});

for (const uid of [null, 'bob']) {
  test(`create/read/update/delete reject ${uid || 'unauthenticated'} access to alice's plant`, async () => {
    await seed();
    const db = client(uid);
    await assertFails(addDoc(collection(db, 'plants'), base()));
    await assertFails(getDoc(plantRef(db)));
    await assertFails(updateDoc(plantRef(db), { name: 'Changed' }));
    await assertFails(deleteDoc(plantRef(db)));
  });
}

test('owner-scoped query used by onSnapshot is permitted; unfiltered and foreign-owner queries are denied', async () => {
  await seed();
  await seed({ ...base(), userId: 'bob' }, 'foreign');
  const db = client();
  const result = await assertSucceeds(getDocs(query(collection(db, 'plants'), where('userId', '==', 'alice'))));
  assert.deepEqual(result.docs.map((item) => item.id), ['plant']);
  await assertFails(getDocs(collection(db, 'plants')));
  await assertFails(getDocs(query(collection(db, 'plants'), where('userId', '==', 'bob'))));
});

const changes = [
  ['plant metadata', { name: 'Новое название', acquiredAt: '2026-11-01' }],
  ['wishlist details', { name: 'Новое желание', description: 'Описание', price: '500 ₽', links: ['https://example.org/plant'] }],
  ['watering append', { wateringLog: [DATE] }],
  ['watering removal', { wateringLog: [] }],
  ['fertilizing append', { fertilizingLog: [DATE] }],
  ['fertilizing removal', { fertilizingLog: [] }],
  ['note append', { notes: [{ id: 'note-1', text: 'Новый лист', createdAt: DATE }] }],
  ['note removal', { notes: [] }],
  ['replant on', { replanted: true }],
  ['replant off', { replanted: false }],
  ['pin', { pinned: true }],
  ['unpin', { pinned: false }],
  ['hide', { hidden: true }],
  ['unhide', { hidden: false }],
  ['move to trash', { deletedAt: DATE, hidden: false, pinned: false }],
  ['restore', { deletedAt: null }],
  ['acquire wishlist', { isWishlisted: false, acquiredAt: '2026-11-20', createdAt: DATE,
    wateringLog: [], fertilizingLog: [], notes: [], pinned: false, hidden: false, replanted: false, deletedAt: null }],
];
for (const [operation, patch] of changes) {
  test(`updateDoc permits ${operation}, preserves legacy photo and unknown historical fields`, async () => {
    // Seed opposite/non-empty states so removals and resets are actual changes.
    const original = { ...legacy(), acquiredAt: '', createdAt: '2020-01-01', isWishlisted: true,
      wateringLog: ['old'], fertilizingLog: ['old'], notes: [{ id: 'old', text: 'Old note', createdAt: '2020-01-01' }],
      pinned: !patch.pinned, hidden: !patch.hidden, replanted: !patch.replanted,
      deletedAt: patch.deletedAt === null ? DATE : null };
    await seed(original);
    await assertSucceeds(updateDoc(plantRef(), patch));
    const stored = (await admin.collection('plants').doc('plant').get()).data();
    for (const [field, value] of Object.entries(patch)) assert.deepEqual(stored[field], value);
    assert.equal(stored.photo, original.photo);
    assert.equal(stored.historicalField, original.historicalField);
  });
}

test('post-migration key-only and no-photo documents permit every current metadata operation', async () => {
  for (const photoFields of [{ photoKey: key }, { photoKey: key, photoThumbKey: key.replace('12345678-', '22345678-') }, {}]) {
    for (const [, patch] of changes) {
      const original = { ...base(), ...photoFields, historicalField: 'preserve',
        acquiredAt: '', createdAt: '2020-01-01', isWishlisted: true,
        wateringLog: ['old'], fertilizingLog: ['old'], notes: [{ id: 'old', text: 'Old note' }],
        pinned: !patch.pinned, hidden: !patch.hidden, replanted: !patch.replanted,
        deletedAt: patch.deletedAt === null ? DATE : null };
      await seed(original);
      await assertSucceeds(updateDoc(plantRef(), patch));
      const stored = (await assertSucceeds(getDoc(plantRef()))).data();
      assert.deepEqual(stored, { ...original, ...patch });
      assert.equal(Object.hasOwn(stored, 'photo'), false);
    }
  }
});

test('final rules restore 47 synthetic legacy trash plants without losing base64 or care history', async () => {
  // Synthetic data only: no production IDs, documents, credentials or photos.
  for (let index = 0; index < 47; index++) {
    const id = `legacy-trash-${index}`;
    const original = { ...legacy(), deletedAt: '2020-01-01T00:00:00.000Z',
      isWishlisted: index % 2 === 0, wateringLog: [DATE], fertilizingLog: [DATE],
      notes: [{ id: 'note', text: 'Keep care history', createdAt: DATE }] };
    await seed(original, id);
    const ref = plantRef(client(), id);
    await assertSucceeds(updateDoc(ref, { deletedAt: null }));
    const stored = (await assertSucceeds(getDoc(ref))).data();
    assert.deepEqual(stored, { ...original, deletedAt: null });
    assert.equal(Object.hasOwn(stored, 'photoKey'), false);
    // Restoring does not migrate the photo, and subsequent care edits still work.
    await assertSucceeds(updateDoc(ref, { name: 'Restored plant', wateringLog: [] }));
    assert.equal((await getDoc(ref)).data().photo, original.photo);
  }
});

test('final rules reject old forms adding photo:null to cleaned documents and photo:null on create', async () => {
  await seed({ ...base(), photoKey: key });
  await assertFails(updateDoc(plantRef(), { name: 'Old form', photo: null }));
  await assertFails(setDoc(plantRef(client(), 'new'), { ...base(), photo: null }));
  assert.deepEqual((await getDoc(plantRef())).data(), { ...base(), photoKey: key });
});

for (const [field, value] of Object.entries({ userId: 'bob', photo: 'new-base64', photoKey: 'attacker/key', photoThumbKey: 'attacker/thumb', _photoDeleting: true })) {
  test(`client cannot create, add, overwrite or remove protected ${field}`, async () => {
    const db = client();
    if (field !== 'userId') await assertFails(setDoc(plantRef(db, 'new'), { ...base(), [field]: value }));
    else await assertFails(setDoc(plantRef(db, 'new'), { ...base(), userId: 'bob' }));
    await seed({ ...legacy(), photoKey: key, photoThumbKey: key.replace('12345678-', '22345678-'), _photoDeleting: false });
    await assertFails(updateDoc(plantRef(db), { [field]: value }));
    await assertFails(updateDoc(plantRef(db), { [field]: deleteField() }));
    // A full replacement cannot silently drop protected fields.
    await assertFails(setDoc(plantRef(db), { ...base(), name: 'Replacement' }));
    if (field !== 'userId') {
      await seed(base(), 'without-protected');
      await assertFails(updateDoc(plantRef(db, 'without-protected'), { [field]: value }));
    }
  });
}

test('unknown fields and nested changes to protected photoKey are rejected', async () => {
  await seed({ ...legacy(), photoKey: key });
  await assertFails(setDoc(plantRef(client(), 'new'), { ...base(), arbitrary: true }));
  await assertFails(updateDoc(plantRef(), { arbitrary: true }));
  await assertFails(updateDoc(plantRef(), { 'photoKey.nested': 'attack' }));
});

test('merge setDoc and transactions obey the same protected-field restrictions', async () => {
  await seed({ ...legacy(), photoKey: key });
  const db = client();
  const ref = plantRef(db);
  await assertSucceeds(setDoc(ref, { name: 'Merged' }, { merge: true }));
  await assertFails(setDoc(ref, { photoKey: 'changed' }, { merge: true }));
  await assertSucceeds(runTransaction(db, async (tx) => {
    await tx.get(ref); tx.update(ref, { pinned: true });
  }));
  await assertFails(runTransaction(db, async (tx) => {
    await tx.get(ref); tx.update(ref, { userId: 'bob' });
  }));
  const batch = writeBatch(db);
  batch.update(ref, { name: 'Batch name', photo: 'new-base64' });
  await assertFails(batch.commit());
  assert.equal((await admin.collection('plants').doc('plant').get()).data().name, 'Merged');
});

test('server photoKey does not block subsequent normal client edits', async () => {
  await seed({ ...legacy(), photoKey: key, _photoDeleting: false });
  await assertSucceeds(updateDoc(plantRef(), { name: 'Ficus', replanted: true, wateringLog: [DATE] }));
  assert.equal((await admin.collection('plants').doc('plant').get()).data().photoKey, key);
});

test('unchanged protected photo fields do not block metadata edits or drop historical fields', async () => {
  const original = { ...legacy(), photoKey: key };
  await seed(original);
  await assertSucceeds(updateDoc(plantRef(), { name: 'Updated', photo: original.photo, photoKey: key }));
  const stored = (await admin.collection('plants').doc('plant').get()).data();
  assert.equal(stored.name, 'Updated');
  assert.equal(stored.photo, original.photo);
  assert.equal(stored.photoKey, key);
  assert.equal(stored.historicalField, original.historicalField);
});

test('null photo is rejected on create and cannot be added to plants or wishes with or without photoKey', async () => {
  const db = client();
  for (const fields of [base(), wish()]) {
    await assertFails(addDoc(collection(db, 'plants'), { ...fields, photo: null }));
    for (const photoFields of [{}, { photoKey: key }]) {
      await seed({ ...fields, ...photoFields });
      await assertFails(updateDoc(plantRef(db), { name: 'Rejected', photo: null }));
      const stored = (await admin.collection('plants').doc('plant').get()).data();
      assert.equal(stored.name, fields.name);
      assert.equal(Object.hasOwn(stored, 'photo'), false);
    }
  }
});

test('deletion lock prevents edits, unlocks and restores; even owner cannot delete a document directly', async () => {
  await seed({ ...legacy(), photoKey: key, deletedAt: DATE, _photoDeleting: true });
  await assertSucceeds(getDoc(plantRef()));
  await assertFails(updateDoc(plantRef(), { name: 'Cannot edit' }));
  await assertFails(updateDoc(plantRef(), { deletedAt: null }));
  await assertFails(updateDoc(plantRef(), { _photoDeleting: false }));
  await assertFails(deleteDoc(plantRef()));
  await seed({ ...legacy(), deletedAt: DATE });
  await assertFails(deleteDoc(plantRef()));
});

test('private upload tickets, arbitrary collections and plant subcollections are inaccessible', async () => {
  await admin.collection('_photoUploads').doc('ticket').set({ uid: 'alice' });
  const db = client();
  const ticket = doc(db, '_photoUploads', 'ticket');
  await assertFails(getDoc(ticket));
  await assertFails(setDoc(ticket, { uid: 'alice' }));
  await assertFails(updateDoc(ticket, { committedKey: 'attack' }));
  await assertFails(deleteDoc(ticket));
  await assertFails(setDoc(doc(db, 'other', 'document'), { userId: 'alice' }));
  await assertFails(setDoc(doc(db, 'plants', 'plant', 'notes', 'note'), { text: 'attack' }));
});

test('real server photo service uses Admin transactions successfully under these rules', async () => {
  let sequence = 0;
  const files = {
    MAX_PHOTO_BYTES: 5 * 1024 * 1024, UPLOAD_SECONDS: 300, READ_SECONDS: 600,
    plantPrefix, ownsPhotoKey,
    signUpload: async () => 'https://storage.invalid/upload',
    validateUpload: async () => Buffer.from('local-fake-photo'),
    storePhotoVersions: async (uid, plantId) => ({
      photoKey: `${plantPrefix(uid, plantId)}photos/00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}.webp`,
      photoThumbKey: `${plantPrefix(uid, plantId)}photos/00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}.webp`,
    }),
    deletePhotoVersions: async () => {},
    readUrl: async () => 'https://storage.invalid/read',
    deletePlantFiles: async () => {},
  };
  const service = createPhotoService({ db: admin, files, deletionEnabled: true });
  for (const isWishlisted of [false, true]) {
    const plantId = isWishlisted ? 'server-wish' : 'server-plant';
    const fields = isWishlisted ? { name: 'Wish', description: '', price: '', links: [] } : { name: 'Ficus', acquiredAt: '' };
    const ticket = await service('alice', { action: 'upload', plantId, size: 100, creating: true });
    const created = await service('alice', { action: 'commit', plantId, uploadId: ticket.uploadId, fields, isWishlisted });
    const ref = plantRef(client(), plantId);
    assert.equal((await assertSucceeds(getDoc(ref))).data().photoKey, created.photoKey);
    assert.equal((await assertSucceeds(getDoc(ref))).data().photoThumbKey, created.photoThumbKey);
    await assertSucceeds(updateDoc(ref, { pinned: true }));
    await assertFails(updateDoc(ref, { photoKey: 'client-replacement' }));
    await assertFails(updateDoc(ref, { photoThumbKey: 'client-thumbnail' }));
    const replacement = await service('alice', { action: 'upload', plantId, size: 100 });
    const updated = await service('alice', { action: 'commit', plantId, uploadId: replacement.uploadId, fields });
    assert.notEqual(updated.photoKey, created.photoKey);
    assert.notEqual(updated.photoThumbKey, created.photoThumbKey);
    await assertSucceeds(updateDoc(ref, { deletedAt: DATE }));
    await assertSucceeds(updateDoc(ref, { deletedAt: null }));
    assert.equal((await getDoc(ref)).data().photoThumbKey, updated.photoThumbKey);
    await assertSucceeds(updateDoc(ref, { deletedAt: DATE }));
    await assertFails(deleteDoc(ref));
    await service('alice', { action: 'delete', plantId });
    assert.equal((await admin.collection('plants').doc(plantId).get()).exists, false);
  }
  const original = { ...legacy(), deletedAt: DATE };
  await seed(original);
  await assertSucceeds(updateDoc(plantRef(), { deletedAt: null }));
  assert.deepEqual(await service('alice', { action: 'read', plantId: 'plant' }), { url: null });
  const ticket = await service('alice', { action: 'upload', plantId: 'plant', size: 100 });
  const committed = await service('alice', { action: 'commit', plantId: 'plant', uploadId: ticket.uploadId,
    fields: { name: 'Restored with new photo', acquiredAt: '' } });
  const restored = (await assertSucceeds(getDoc(plantRef()))).data();
  assert.equal(restored.photo, original.photo);
  assert.equal(restored.photoKey, committed.photoKey);
  assert.equal(restored.deletedAt, null);
  await assertSucceeds(updateDoc(plantRef(), { wateringLog: [DATE] }));
});
