const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs, query, where, deleteField, setLogLevel } = require('firebase/firestore');

const projectId = 'demo-ficus-diary-rules';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)
  || (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== projectId)) {
  throw new Error('Run npm run test:rules with the local demo emulator only.');
}
const rules = (file) => readFileSync(resolve(__dirname, '../..', file), 'utf8');
const base = () => ({ name: 'Ficus', userId: 'alice', acquiredAt: '', createdAt: '2026-11-20',
  wateringLog: [], fertilizingLog: [], notes: [], pinned: false, hidden: false, deletedAt: null });
const legacyPhoto = 'data:image/jpeg;base64,bGVnYWN5';
const legacy = () => ({ ...base(), photo: legacyPhoto });
const wish = () => ({ name: 'Wish', description: '', price: '', links: [], isWishlisted: true,
  userId: 'alice', createdAt: '2026-11-20', deletedAt: null, hidden: false, pinned: false });
let env;
const db = (uid = 'alice') => env.authenticatedContext(uid).firestore();
const ref = (client = db(), id = 'plant') => doc(client, 'plants', id);
const seed = (data) => env.withSecurityRulesDisabled((context) => setDoc(ref(context.firestore()), data));
const loadRules = async (file) => {
  if (env) await env.cleanup();
  const [hostname, port] = host.split(':');
  env = await initializeTestEnvironment({ projectId,
    firestore: { host: hostname, port: Number(port), rules: rules(file) } });
};
before(async () => { setLogLevel('silent'); await loadRules('firestore.transition.rules'); });
beforeEach(async () => {
  await env.clearFirestore();
  await loadRules('firestore.transition.rules');
});
after(async () => { if (env) await env.cleanup(); });

test('observed production rules accept new client payloads but also allow old direct deletion', async () => {
  await loadRules('tests/firestore/fixtures/production-2025-12-10.rules');
  for (const fields of [base(), wish()]) await assertSucceeds(addDoc(collection(db(), 'plants'), fields));
  await seed({ ...legacy(), photoKey: 'server-key' });
  await assertSucceeds(getDocs(query(collection(db(), 'plants'), where('userId', '==', 'alice'))));
  await assertSucceeds(updateDoc(ref(), { name: 'Updated', replanted: true, deletedAt: null }));
  // Document the actual deployment risk, never exercise this against production.
  await assertSucceeds(deleteDoc(ref()));
});

test('bridge accepts old plant and wishlist creation including null/base64 photos', async () => {
  for (const fields of [base(), wish()]) {
    for (const photo of [null, legacyPhoto]) {
      await assertSucceeds(addDoc(collection(db(), 'plants'), { ...fields, photo }));
    }
  }
});

test('bridge permits old metadata/photo edits on legacy documents and preserves unknown history', async () => {
  await seed({ ...legacy(), historicalField: 'keep' });
  await assertSucceeds(updateDoc(ref(), { name: 'Old form', acquiredAt: '', photo: legacyPhoto }));
  await assertSucceeds(updateDoc(ref(), { photo: 'data:image/webp;base64,bmV3' }));
  await assertSucceeds(updateDoc(ref(), { photo: null }));
  await env.withSecurityRulesDisabled(async (context) => {
    const { getDoc } = require('firebase/firestore');
    assert.equal((await getDoc(ref(context.firestore()))).data().historicalField, 'keep');
  });
});

test('bridge accepts all new client metadata operations and owner-scoped queries after API upload', async () => {
  for (const fields of [base(), wish()]) await assertSucceeds(addDoc(collection(db(), 'plants'), fields));
  await seed({ ...legacy(), photoKey: 'server-key' });
  await assertSucceeds(getDocs(query(collection(db(), 'plants'), where('userId', '==', 'alice'))));
  for (const patch of [
    { name: 'New form', acquiredAt: '2026-11-20' },
    { description: 'Details', price: '500', links: ['https://example.org'], isWishlisted: true },
    { wateringLog: ['2026-11-20'], fertilizingLog: [], notes: [{ id: '1', text: 'Leaf', createdAt: '2026-11-20' }] },
    { replanted: true, pinned: true, hidden: true },
    { deletedAt: '2026-11-20', pinned: false, hidden: false },
    { deletedAt: null },
    { isWishlisted: false, acquiredAt: '', createdAt: '2026-11-21', wateringLog: [], fertilizingLog: [],
      notes: [], pinned: false, hidden: false, replanted: false, deletedAt: null },
  ]) await assertSucceeds(updateDoc(ref(), patch));
});

test('bridge rejects old photo changes on S3 documents while allowing unchanged photo/null', async () => {
  await seed({ ...legacy(), photoKey: 'server-key' });
  await assertSucceeds(updateDoc(ref(), { name: 'Old form', photo: legacyPhoto }));
  for (const photo of [null, 'replacement', deleteField()]) await assertFails(updateDoc(ref(), { photo }));
  const s3Only = { ...base(), photoKey: 'server-key' };
  await seed(s3Only);
  await assertSucceeds(updateDoc(ref(), { name: 'Old form on new plant', photo: null }));
  await assertFails(updateDoc(ref(), { photo: legacyPhoto }));
});

test('bridge rejects client storage keys, deletion locks, owner changes, direct deletes and private tickets', async () => {
  await seed({ ...legacy(), photoKey: 'server-key' });
  for (const patch of [{ userId: 'bob' }, { photoKey: 'attack' }, { _photoDeleting: true }]) {
    await assertFails(updateDoc(ref(), patch));
    await assertFails(setDoc(ref(db(), 'new'), { ...base(), ...patch }));
  }
  await assertFails(updateDoc(ref(), { photoKey: deleteField() }));
  await assertFails(deleteDoc(ref()));
  await assertFails(updateDoc(ref(db('bob')), { name: 'Attack' }));
  await assertFails(setDoc(doc(db(), '_photoUploads', 'ticket'), { uid: 'alice' }));
  await seed({ ...legacy(), _photoDeleting: true });
  await assertFails(updateDoc(ref(), { deletedAt: null }));
});

test('final rules deliberately reject changed legacy photos but keep old unchanged-photo metadata edits', async () => {
  await loadRules('firestore.rules');
  await seed(legacy());
  await assertSucceeds(updateDoc(ref(), { name: 'Old unchanged photo form', photo: legacyPhoto }));
  await assertFails(updateDoc(ref(), { photo: 'replacement' }));
  await assertFails(addDoc(collection(db(), 'plants'), legacy()));
  await assertFails(deleteDoc(ref()));
});
