const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { parseArgs, assertProject, migratePlant, convertLegacyPhoto, runMigration } = require('../../scripts/migrate-photos.cjs');
const storage = require('../../server/storage.cjs');

const legacy = { userId: 'owner', photo: 'data:image/png;base64,bGVnYWN5', name: 'Ficus', deletedAt: null };
const bulk = { project: 'my-plants-app-8f6fc', user: 'owner', all: true, apply: true };

// In-memory Firestore and S3 only: no credentials, environment files or network.
function fixture(initial, { beforeCommit, afterCommit, onPut, onConvert, queryErrorAt } = {}) {
  const records = new Map(Object.entries(structuredClone(initial)));
  const objects = new Map();
  const writes = [];
  const queries = [];
  let reads = 0;
  const snapshot = (id) => ({ id, exists: records.has(id), ref: { id },
    data: () => structuredClone(records.get(id)) });
  const query = (state = {}) => ({
    where: (field, op, value) => { assert.equal(field, 'userId'); assert.equal(op, '=='); return query({ ...state, user: value }); },
    orderBy: (field) => { assert.equal(field, '__name__'); return query(state); },
    limit: (size) => query({ ...state, size }),
    startAfter: (cursor) => query({ ...state, cursor: cursor.id }),
    get: async () => {
      reads += 1;
      if (reads === queryErrorAt) throw new Error('secret signed URL');
      queries.push({ ...state });
      const ids = [...records.keys()].sort().filter((id) => records.get(id).userId === state.user
        && (!state.cursor || id > state.cursor)).slice(0, state.size);
      return { docs: ids.map(snapshot), size: ids.length };
    },
    doc: (id) => ({ get: async () => snapshot(id) }),
  });
  const db = {
    collection: (name) => { assert.equal(name, 'plants'); return query(); },
    runTransaction: mock.fn(async (callback) => {
      const pending = [];
      const result = await callback({
        get: async (ref) => snapshot(ref.id),
        update: (ref, patch) => pending.push({ id: ref.id, patch }),
      });
      await beforeCommit?.(pending);
      for (const entry of pending) {
        writes.push(entry);
        records.set(entry.id, { ...records.get(entry.id), ...entry.patch });
      }
      await afterCommit?.(pending);
      return result;
    }),
  };
  const client = { send: mock.fn(async (command) => {
    const { Key: key } = command.input;
    if (command.constructor.name === 'HeadObjectCommand') {
      if (objects.has(key)) return structuredClone(objects.get(key));
      throw Object.assign(new Error('absent'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    }
    assert.equal(command.constructor.name, 'PutObjectCommand');
    await onPut?.(command, records);
    objects.set(key, { ContentLength: command.input.Body.length, ContentType: command.input.ContentType,
      Metadata: { ...command.input.Metadata } });
    return {};
  }) };
  const files = { storeMigrationPhoto: mock.fn((uid, id, bytes) =>
    storage.storeMigrationPhoto(uid, id, bytes, { client, bucket: 'fake-bucket' })) };
  const convert = mock.fn(async (photo) => {
    await onConvert?.(photo);
    return Buffer.from('webp:' + photo);
  });
  const events = [];
  const run = (overrides = {}) => runMigration({ db, files, convert,
    options: { ...bulk, ...overrides }, onResult: (event) => events.push(event) });
  const puts = () => client.send.mock.calls.filter((call) => call.arguments[0].constructor.name === 'PutObjectCommand');
  return { records, objects, writes, queries, db, files, convert, snapshot, events, run, puts };
}

test('CLI defaults to dry-run; bulk writes require --all; single-plant mode remains available', () => {
  const base = ['--project', 'test', '--user', 'owner'];
  assert.equal(parseArgs(base).apply, false);
  assert.equal(parseArgs([...base, '--all', '--dry-run']).apply, false);
  assert.equal(parseArgs([...base, '--all', '--apply', '--limit', '10']).limit, 10);
  assert.equal(parseArgs([...base, '--plant', 'plant-1', '--apply']).plant, 'plant-1');
  assert.equal(parseArgs([...base, '--all', '--stop-on-error']).stopOnError, true);
  assert.throws(() => parseArgs([...base, '--apply']), /--plant.*--all/);
  assert.throws(() => parseArgs(['--apply', '--plant', 'plant-1']), /--project/);
  assert.throws(() => parseArgs([...base, '--all', '--plant', 'plant-1']), /Choose/);
  assert.throws(() => parseArgs([...base, '--all', '--apply', '--dry-run']), /Choose/);
  for (const value of ['0', '-1', '1.1', '1e2', 'Infinity', '9007199254740992', 'no']) {
    assert.throws(() => parseArgs([...base, '--all', '--limit', value]), /--limit/);
  }
  assert.throws(() => parseArgs([...base, '--plant', 'plant-1', '--limit', '1']), /--limit/);
  assert.throws(() => parseArgs([...base, '--limit']), /Value/);
  assert.throws(() => parseArgs([...base, '--all', '--all']), /Duplicate/);
  assert.throws(() => parseArgs([...base, '--user', 'another']), /Duplicate/);
  assert.throws(() => parseArgs([...base, '--wat']), /Unknown/);
  assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('project is checked against environment and initialized Admin app/database', () => {
  const env = { FIREBASE_PROJECT_ID: bulk.project };
  const firebase = { db: { projectId: bulk.project, databaseId: '(default)' },
    auth: { app: { options: { projectId: bulk.project } } } };
  assert.doesNotThrow(() => assertProject(bulk.project, env, firebase));
  assert.throws(() => assertProject('other', env), /--project/);
  for (const key of ['REACT_APP_FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    assert.throws(() => assertProject(bulk.project, { ...env, [key]: 'other' }), /Conflicting/);
  }
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    assert.throws(() => assertProject(bulk.project, { ...env, [key]: 'localhost' }), /Emulator/);
  }
  assert.throws(() => assertProject(bulk.project, env, { ...firebase, db: { projectId: 'other' } }), /another project/);
  assert.throws(() => assertProject(bulk.project, env, { ...firebase,
    auth: { app: { options: { projectId: 'other' } } } }), /another project/);
  assert.throws(() => assertProject(bulk.project, env, { ...firebase,
    db: { projectId: bulk.project, databaseId: 'other' } }), /another project/);
});

test('bulk migration scopes owner, includes wishlist, preserves every field except adding photoKey, and skips ineligible plants', async () => {
  const initial = {
    a: legacy, b: { ...legacy, isWishlisted: true, description: 'wish', price: 42, links: ['url'] },
    c: { ...legacy, photoKey: 'existing' }, d: { ...legacy, deletedAt: '2026-11-19' },
    e: { ...legacy, _photoDeleting: true }, f: { ...legacy, photo: null },
    g: { ...legacy, photo: 'https://example.com/image.png' },
    h: { ...legacy, userId: 'other' }, i: { ...legacy, photo: 'data:image/png,url' },
  };
  const f = fixture(initial);
  const report = await f.run();
  assert.equal(report.totalFound, 8);
  assert.equal(report.eligible, 2);
  assert.equal(report.migrated, 2);
  assert.equal(report.skipped, 6);
  assert.equal(report.errors, 0);
  assert.equal(report.scanComplete, true);
  assert.deepEqual(report.skippedByReason, { photoKey: 1, trash: 1, deleting: 1, 'no-base64': 3 });
  assert.equal(report.uploadedBytes, f.puts().reduce((sum, call) => sum + call.arguments[0].input.Body.length, 0));
  assert.equal(f.queries[0].user, 'owner');
  for (const [id, before] of Object.entries(initial)) {
    const after = f.records.get(id);
    if (['a', 'b'].includes(id)) {
      assert.ok(storage.ownsPhotoKey('owner', id, after.photoKey));
      const { photoKey, ...rest } = after;
      assert.deepEqual(rest, before);
    } else assert.deepEqual(after, before);
  }
  assert.ok(f.writes.every(({ patch }) => Object.keys(patch).join() === 'photoKey'));
});

test('dry-run reports exact converted byte estimates and candidates with no S3 calls or Firestore writes', async () => {
  const f = fixture({ a: legacy, b: { ...legacy, isWishlisted: true }, c: { ...legacy, photoKey: 'exists' } });
  const report = await f.run({ apply: false });
  assert.equal(report.totalFound, 3);
  assert.equal(report.eligible, 2);
  assert.equal(report.dryRunPhotos, 2);
  assert.equal(report.estimatedBytes, 2 * Buffer.byteLength('webp:' + legacy.photo));
  assert.equal(report.uploadedBytes, 0);
  assert.equal(report.migrated, 0);
  assert.equal(f.files.storeMigrationPhoto.mock.callCount(), 0);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.records.get('a').photoKey, undefined);
});

test('bulk processing is sequential across pages; limit counts eligible attempts and resume skips successes', async () => {
  let active = 0;
  let maxActive = 0;
  const initial = { '000-skip': { ...legacy, photoKey: 'exists' } };
  for (let i = 0; i < 112; i += 1) initial['plant-' + String(i).padStart(3, '0')] = { ...legacy, isWishlisted: i % 2 === 0 };
  const f = fixture(initial, { onConvert: async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  } });
  const first = await f.run({ limit: 10 });
  assert.equal(first.totalFound, 113);
  assert.equal(first.migrated, 10);
  assert.equal(first.attempted, 10);
  assert.equal(first.deferred, 102);
  assert.equal(first.skipped, 1);
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[1].cursor, 'plant-098');
  assert.equal(f.convert.mock.callCount(), 10);
  const second = await f.run();
  assert.equal(second.migrated, 102);
  assert.equal(second.skipped, 11);
  assert.equal(second.deferred, 0);
  assert.equal(maxActive, 1);
  assert.equal(f.puts().length, 112);
  const third = await f.run();
  assert.equal(third.migrated, 0);
  assert.equal(third.skipped, 113);
  assert.equal(third.uploadedBytes, 0);
  assert.equal(f.puts().length, 112);
  assert.equal(f.convert.mock.callCount(), 112);
});

test('conversion and upload failures leave plants intact; default continues and report hides raw errors', async () => {
  const initial = { a: legacy, b: { ...legacy, photo: 'data:image/png;base64,broken' }, c: { ...legacy, photo: 'data:image/png;base64,failUpload' }, d: legacy };
  const f = fixture(initial, {
    onConvert: async (photo) => { if (photo.endsWith('broken')) throw new Error('secret signed URL'); },
    onPut: async (command) => { if (command.input.Key.includes('/c/')) throw new Error('secret credentials'); },
  });
  const report = await f.run();
  assert.equal(report.errors, 2);
  assert.equal(report.migrated, 2);
  assert.equal(report.stopped, false);
  assert.equal(report.scanComplete, true);
  assert.deepEqual(f.records.get('b'), initial.b);
  assert.deepEqual(f.records.get('c'), initial.c);
  assert.deepEqual(f.events.filter((event) => event.status === 'error').map((event) => event.code),
    ['CONVERSION_FAILED', 'STORAGE_FAILED']);
  assert.equal(JSON.stringify([report, f.events]).includes('secret'), false);
  assert.equal(report.uploadedBytes, 2 * Buffer.byteLength('webp:' + legacy.photo));
});

test('failed Firestore commit leaves original intact; retry reuses deterministic S3 object without another PUT', async () => {
  let fail = true;
  const f = fixture({ a: legacy }, { beforeCommit: async () => { if (fail) throw new Error('commit failed'); } });
  const first = await f.run();
  assert.equal(first.errors, 1);
  assert.equal(first.migrated, 0);
  assert.equal(first.uploadedBytes, Buffer.byteLength('webp:' + legacy.photo));
  assert.deepEqual(f.records.get('a'), legacy);
  assert.equal(f.objects.size, 1);
  assert.equal(f.events[0].code, 'FIRESTORE_FAILED');
  fail = false;
  const second = await f.run();
  assert.equal(second.migrated, 1);
  assert.equal(second.uploadedBytes, 0);
  assert.equal(second.reusedObjects, 1);
  assert.equal(f.puts().length, 1);
  assert.equal(f.records.get('a').photo, legacy.photo);
});

test('lost PUT response can be resumed without a duplicate upload or premature Firestore update', async () => {
  const f = fixture({ a: legacy });
  const realStore = f.files.storeMigrationPhoto;
  f.files.storeMigrationPhoto = async (...args) => {
    await realStore(...args);
    throw new Error('lost upload response');
  };
  const first = await f.run();
  assert.equal(first.errors, 1);
  assert.deepEqual(f.records.get('a'), legacy);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  f.files.storeMigrationPhoto = realStore;
  const second = await f.run();
  assert.equal(second.migrated, 1);
  assert.equal(second.reusedObjects, 1);
  assert.equal(f.puts().length, 1);
});

test('lost Firestore commit response is safe to retry: committed photoKey is skipped', async () => {
  let fail = true;
  const f = fixture({ a: legacy }, { afterCommit: async () => { if (fail) throw new Error('lost response'); } });
  assert.equal((await f.run()).errors, 1);
  assert.ok(f.records.get('a').photoKey);
  fail = false;
  const retry = await f.run();
  assert.equal(retry.skipped, 1);
  assert.equal(retry.migrated, 0);
  assert.equal(f.puts().length, 1);
});

test('transaction rechecks source photo, owner, photoKey, trash, deletion lock and document existence', async () => {
  for (const change of [
    (records) => records.get('a').photo = 'changed',
    (records) => records.get('a').userId = 'other',
    (records) => records.get('a').photoKey = 'newer-key',
    (records) => records.get('a').deletedAt = '2026-11-20',
    (records) => records.get('a')._photoDeleting = true,
    (records) => records.delete('a'),
  ]) {
    const f = fixture({ a: legacy }, { onPut: async (_, records) => change(records) });
    const report = await f.run();
    assert.equal(report.errors, 1);
    assert.equal(report.migrated, 0);
    assert.equal(report.uploadedBytes, Buffer.byteLength('webp:' + legacy.photo));
    assert.equal(f.writes.length, 0);
    assert.equal(f.events[0].code, 'PLANT_CHANGED');
  }
});

test('stop-on-error prints a partial report; batch limit bounds failures too', async () => {
  const f = fixture({ a: legacy, b: legacy, c: legacy }, { onConvert: async () => { throw new Error('broken'); } });
  const stopped = await f.run({ stopOnError: true });
  assert.equal(stopped.errors, 1);
  assert.equal(stopped.totalFound, 1);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.scanComplete, false);
  const limited = await f.run({ limit: 2 });
  assert.equal(limited.totalFound, 3);
  assert.equal(limited.attempted, 2);
  assert.equal(limited.errors, 2);
  assert.equal(limited.deferred, 1);
  assert.equal(limited.scanComplete, true);
});

test('pagination failure returns a partial report with successes retained', async () => {
  const initial = {};
  for (let i = 0; i < 101; i += 1) initial['plant-' + String(i).padStart(3, '0')] = legacy;
  const f = fixture(initial, { queryErrorAt: 2 });
  const report = await f.run();
  assert.equal(report.totalFound, 100);
  assert.equal(report.migrated, 100);
  assert.equal(report.errors, 1);
  assert.equal(report.fatalError, 'FIRESTORE_SCAN_FAILED');
  assert.equal(report.scanComplete, false);
  assert.equal(report.stopped, true);
  assert.equal(f.records.get('plant-100').photoKey, undefined);
});

test('single-plant mode reports skips/missing plants and rejects another owner before conversion/storage', async () => {
  const f = fixture({ a: legacy, b: { ...legacy, userId: 'other' } });
  const dryRun = await f.run({ plant: 'a', all: undefined, apply: false });
  assert.equal(dryRun.dryRunPhotos, 1);
  assert.equal(f.queries.length, 0);
  await assert.rejects(migratePlant({ db: f.db, snapshot: f.snapshot('b'), userId: 'owner', apply: true,
    files: f.files, convert: f.convert }), /Owner/);
  assert.equal(f.files.storeMigrationPhoto.mock.callCount(), 0);
  const missing = await f.run({ plant: 'missing', all: undefined });
  assert.equal(missing.errors, 1);
  assert.equal(f.events.at(-1).code, 'PLANT_NOT_FOUND');
  const migrated = await f.run({ plant: 'a', all: undefined });
  assert.equal(migrated.migrated, 1);
  assert.equal((await f.run({ plant: 'a', all: undefined })).skipped, 1);
});

test('legacy conversion outputs WebP <=1600px without enlarging small images', async () => {
  for (const [width, height, expected] of [[3000, 2000, 1600], [200, 400, 400]]) {
    const source = await sharp({ create: { width, height, channels: 3, background: '#297c41' } }).png().toBuffer();
    const result = await convertLegacyPhoto('data:image/png;base64,' + source.toString('base64'));
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(Math.max(metadata.width, metadata.height), expected);
  }
  await assert.rejects(convertLegacyPhoto('data:text/html;base64,AA=='));
  await assert.rejects(convertLegacyPhoto('data:image/png;base64,broken'));
});
