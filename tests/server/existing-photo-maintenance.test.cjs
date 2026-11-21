const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const storage = require('../../server/storage.cjs');
const { parseArgs, thumbnailKey, runBackfill } = require('../../scripts/backfill-photo-thumbnails.cjs');
const { parseArgs: parseDiagnosisArgs, runDiagnosis } = require('../../scripts/diagnose-photo-storage.cjs');
const { approximatePhotoFieldBytes } = require('../../scripts/cleanup-base64-photos.cjs');

const project = 'test-photo-maintenance';
const legacy = 'data:image/png;base64,UFJJVkFURV9JTUFHRQ==';
const privateUrl = 'https://private.invalid/?X-Amz-Signature=DO_NOT_LOG';
const keyFor = (id, uid = 'PRIVATE_OWNER') => `${storage.plantPrefix(uid, id)}photos/12345678-1234-1234-1234-123456789abc.webp`;
const plant = (id, extra = {}) => ({ userId: 'PRIVATE_OWNER', photoKey: keyFor(id), photo: legacy,
  name: 'PRIVATE_NAME', deletedAt: null, notes: [{ text: 'PRIVATE_NOTE' }], ...extra });
const sourceBytes = sharp({ create: { width: 600, height: 900, channels: 3, background: '#297c41' } }).webp().toBuffer();
const objectFor = (bytes, metadata = {}) => ({ bytes: Buffer.from(bytes), ContentType: 'image/webp',
  Metadata: metadata, ETag: `"${createHash('sha256').update(bytes).digest('hex')}"` });

// Only memory and local sharp: no env files, cloud SDK connections or real writes.
async function fixture(initial, hooks = {}) {
  const records = new Map(Object.entries(structuredClone(initial)));
  const objects = new Map();
  const mainKeys = new Set();
  const bytes = await sourceBytes;
  for (const [id, data] of records) {
    if (storage.ownsPhotoKey(data.userId || '', id, data.photoKey)) {
      objects.set(data.photoKey, objectFor(bytes));
      mainKeys.add(data.photoKey);
    }
  }
  const commands = [], queries = [], writes = [], events = [];
  const snapshot = (id, fields) => {
    let data = structuredClone(records.get(id));
    if (fields && data) data = Object.fromEntries(fields.filter((field) => Object.hasOwn(data, field)).map((field) => [field, data[field]]));
    return { id, ref: { id, path: `plants/${id}` }, exists: records.has(id), data: () => structuredClone(data) };
  };
  const query = (state = {}) => ({
    orderBy: (field) => { assert.equal(field, '__name__'); return query(state); },
    limit: (size) => { assert.equal(size, 100); return query({ ...state, size }); },
    select: (...fields) => query({ ...state, fields }),
    startAfter: (cursor) => query({ ...state, cursor: cursor.id }),
    get: async () => {
      queries.push(state);
      if (queries.length === hooks.failPage) throw new Error(privateUrl);
      const ids = [...records.keys()].sort().filter((id) => !state.cursor || id > state.cursor).slice(0, state.size);
      return { size: ids.length, docs: ids.map((id) => snapshot(id, state.fields)) };
    },
  });
  const db = { collection: (name) => { assert.equal(name, 'plants'); return query(); },
    runTransaction: mock.fn(async (callback) => {
      const pending = [];
      const tx = {
        get: async (ref) => { await hooks.beforeTransactionRead?.(records); return snapshot(ref.id); },
        update: (ref, patch) => {
          assert.deepEqual(Object.keys(patch), ['photoThumbKey']);
          pending.push({ id: ref.id, patch });
        },
      };
      let result = await callback(tx);
      if (hooks.beforeRetry) {
        pending.length = 0;
        await hooks.beforeRetry(records);
        result = await callback(tx);
      }
      await hooks.beforeCommit?.();
      for (const write of pending) {
        records.set(write.id, { ...records.get(write.id), ...write.patch });
        writes.push(write);
      }
      await hooks.afterCommit?.();
      return result;
    }),
  };
  const connection = { bucket: 'same-private-bucket', client: { send: async (command, options) => {
    commands.push(command);
    const { Key: key } = command.input;
    const name = command.constructor.name;
    assert.equal(command.input.Bucket, connection.bucket);
    if (name === 'PutObjectCommand') {
      assert.ok(!mainKeys.has(key), 'Originals must never be overwritten');
      assert.equal(command.input.ContentType, 'image/webp');
      assert.equal(command.input.CacheControl, 'private, max-age=300');
      assert.equal(command.input.ACL, undefined);
      await hooks.beforePut?.({ key, records, objects });
      objects.set(key, objectFor(command.input.Body, command.input.Metadata));
      await hooks.afterPut?.({ key, records, objects });
      return {};
    }
    assert.ok(['HeadObjectCommand', 'GetObjectCommand'].includes(name), 'No S3 deletes/copies/listing allowed');
    if (name === 'HeadObjectCommand') await hooks.onHead?.({ key, records, objects });
    const object = objects.get(key);
    if (!object) throw Object.assign(new Error(privateUrl), { $metadata: { httpStatusCode: 404 } });
    const headers = { ContentLength: object.bytes.length, ContentType: object.ContentType,
      ETag: object.ETag, Metadata: object.Metadata };
    if (name === 'HeadObjectCommand') return headers;
    assert.ok(options.abortSignal instanceof AbortSignal);
    assert.equal(command.input.IfMatch, object.ETag);
    await hooks.onGet?.({ key, records, objects });
    return { ...headers, Body: Readable.from([object.bytes]) };
  } } };
  const run = async (options = {}) => {
    const report = await runBackfill({ db, connection, options: { project, apply: false, stopOnError: false, ...options },
      onResult: (event) => events.push(event) });
    const output = JSON.stringify({ report, events });
    for (const value of [legacy, privateUrl, 'PRIVATE_OWNER', 'PRIVATE_NAME', 'PRIVATE_NOTE', 'plants/']) assert.ok(!output.includes(value));
    return report;
  };
  const puts = () => commands.filter((command) => command.constructor.name === 'PutObjectCommand');
  return { db, records, objects, commands, queries, writes, events, connection, run, puts };
}

test('new CLIs default to dry-run/read-only and reject conflicting, unknown or duplicate options', () => {
  const args = ['--project', project];
  assert.deepEqual(parseArgs(args), { project, apply: false, stopOnError: false });
  assert.equal(parseArgs([...args, '--apply', '--limit', '3']).apply, true);
  assert.equal(parseArgs([...args, '--dry-run']).apply, false);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const extra of [['--apply', '--dry-run'], ['--apply', '--apply'], ['--limit'], ['--project', project],
    ['--limit', '0'], ['--limit', '1e2'], ['--limit', '9007199254740992'], ['--user', 'owner'], ['--help']]) {
    assert.throws(() => parseArgs([...args, ...extra]));
  }
  assert.throws(() => parseArgs([]));
  assert.deepEqual(parseDiagnosisArgs(args), { project });
  for (const extra of [['--apply'], ['--limit', '1'], ['--stop-on-error']]) assert.throws(() => parseDiagnosisArgs([...args, ...extra]));
});

test('inventory counts all photo kinds, owners, wishlist and trash without S3 or writes', async () => {
  const initial = {
    a: plant('a'), b: plant('b', { photoThumbKey: 'already-present', isWishlisted: true }),
    c: plant('c', { deletedAt: 'old', userId: 'other', photoKey: keyFor('c', 'other'), photoThumbKey: null }),
    d: { photo: legacy }, e: { photo: 'https://external/image', isWishlisted: true },
    f: { photo: 'http://external/image', deletedAt: 'old', isWishlisted: true }, g: { photoKey: null },
  };
  const f = await fixture(initial);
  const report = await runDiagnosis({ db: f.db, options: { project } });
  assert.equal(report.documents, 7);
  assert.equal(report.withPhotoKey, 3);
  assert.equal(report.withThumbnail, 1);
  assert.equal(report.missingThumbnail, 2);
  assert.equal(report.base64Photos, 4);
  assert.equal(report.base64WithPhotoKey, 3);
  assert.equal(report.externalPhotos, 2);
  assert.equal(report.estimatedBase64Bytes, 4 * approximatePhotoFieldBytes(legacy));
  assert.equal(report.bySection.plants.documents, 3);
  assert.equal(report.bySection.wishlist.documents, 2);
  assert.equal(report.bySection.trash.documents, 2);
  assert.equal(report.errors, 0);
  assert.equal(report.scanComplete, true);
  assert.deepEqual(f.commands, []);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  assert.deepEqual(Object.fromEntries(f.records), initial);
  assert.ok(!JSON.stringify(report).includes(legacy));
});

test('inventory paginates completely and marks failed reads as partial', async () => {
  const initial = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${String(i).padStart(3, '0')}`, { photo: legacy }]));
  const f = await fixture(initial);
  const report = await runDiagnosis({ db: f.db, options: { project } });
  assert.equal(report.documents, 200);
  assert.equal(f.queries.length, 3, 'Full final page requires an empty next page');
  const partial = await fixture(initial, { failPage: 2 });
  const failed = await runDiagnosis({ db: partial.db, options: { project } });
  assert.equal(failed.documents, 100);
  assert.equal(failed.scanComplete, false);
  assert.equal(failed.errorsByCode.FIRESTORE_SCAN_FAILED, 1);
});

test('backfill dry-run reads/validates originals and creates real thumbnails in memory without writes', async () => {
  const initial = { a: plant('a'), b: plant('b', { deletedAt: 'old' }) };
  const f = await fixture(initial);
  const report = await f.run();
  assert.equal(report.dryRunPhotos, 2);
  assert.equal(report.estimatedThumbnailBytes, 2 * (await storage.createPhotoThumbnail(await sourceBytes)).length);
  assert.equal(report.uploadedBytes, 0);
  assert.equal(report.errors, 0);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  assert.deepEqual(f.puts(), []);
  assert.deepEqual(Object.fromEntries(f.records), initial);
  assert.ok(!f.queries[0].fields.includes('photo'), 'Do not fetch large legacy base64 during thumbnail backfill');
});

test('backfill adds only photoThumbKey for all owners/list types and preserves originals, base64 and history', async () => {
  const initial = {
    a: plant('a'), b: plant('b', { userId: 'other', photoKey: keyFor('b', 'other'), isWishlisted: true }),
    c: plant('c', { deletedAt: 'old', isWishlisted: true }), d: plant('d', { photoThumbKey: 'existing' }),
    e: { photo: 'https://external/image' }, f: plant('f', { _photoDeleting: true }),
  };
  const f = await fixture(initial);
  const mainCopies = new Map([...f.objects].map(([key, object]) => [key, Buffer.from(object.bytes)]));
  const report = await f.run({ apply: true });
  assert.equal(report.created, 3);
  assert.equal(report.processed, 3);
  assert.equal(report.skipped, 3);
  assert.equal(report.errors, 0);
  assert.deepEqual(report.skippedByReason, { 'has-thumbnail': 1, 'no-photo-key': 1, 'photo-deleting': 1 });
  for (const id of ['a', 'b', 'c']) {
    const data = f.records.get(id);
    assert.deepEqual(data, { ...initial[id], photoThumbKey: data.photoThumbKey });
    assert.notEqual(data.photoThumbKey, data.photoKey);
    assert.ok(storage.ownsPhotoKey(data.userId, id, data.photoThumbKey));
    const metadata = await sharp(f.objects.get(data.photoThumbKey).bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [200, 300, 'webp']);
  }
  for (const [key, bytes] of mainCopies) assert.deepEqual(f.objects.get(key).bytes, bytes);
  assert.equal((await f.run({ apply: true })).skipped, 6);
  assert.equal(f.puts().length, 3, 'Successful reruns must not upload again');
  assert.equal(f.writes.length, 3);
});

test('lost PUT or failed Firestore response can be resumed using the existing immutable thumbnail', async () => {
  for (const stage of ['afterPut', 'beforeCommit']) {
    let fail = true;
    const f = await fixture({ a: plant('a') }, { [stage]: () => { if (fail) { fail = false; throw new Error(privateUrl); } } });
    assert.equal((await f.run({ apply: true })).errors, 1);
    assert.equal(f.records.get('a').photoThumbKey, undefined);
    const retry = await f.run({ apply: true });
    assert.equal(retry.created, 1);
    assert.equal(retry.reusedObjects, 1);
    assert.equal(retry.uploadedBytes, 0);
    assert.equal(f.puts().length, 1);
    assert.equal(f.records.get('a').photo, legacy);
  }
});

test('a lost committed transaction response is skipped safely on rerun', async () => {
  let fail = true;
  const f = await fixture({ a: plant('a') }, { afterCommit: () => { if (fail) { fail = false; throw new Error(privateUrl); } } });
  assert.equal((await f.run({ apply: true })).errorsByCode.FIRESTORE_FAILED_OR_OUTCOME_UNKNOWN, 1);
  assert.ok(f.records.get('a').photoThumbKey);
  assert.equal((await f.run({ apply: true })).skippedByReason['has-thumbnail'], 1);
  assert.equal(f.puts().length, 1);
});

test('transaction checks photoKey, owner, deletion lock and existence again after reading/uploading', async () => {
  for (const mutate of [
    (records) => { records.get('a').photoKey = keyFor('changed'); },
    (records) => { records.get('a').userId = 'changed'; },
    (records) => { records.get('a')._photoDeleting = true; },
    (records) => { records.delete('a'); },
  ]) {
    const f = await fixture({ a: plant('a') }, { onGet: ({ records }) => mutate(records) });
    const report = await f.run({ apply: true });
    assert.equal(report.errors, 1);
    assert.deepEqual(f.writes, []);
  }
  const retry = await fixture({ a: plant('a') }, { beforeRetry: (records) => { records.get('a').photoKey = keyFor('changed'); } });
  assert.equal((await retry.run({ apply: true })).errorsByCode.PLANT_CHANGED, 1);
  assert.deepEqual(retry.writes, []);
});

test('a concurrent thumbnail is preserved and unrelated edits or trash transitions survive', async () => {
  const concurrent = await fixture({ a: plant('a') }, { onGet: ({ records }) => { records.get('a').photoThumbKey = 'winner'; } });
  assert.equal((await concurrent.run({ apply: true })).skippedByReason['has-thumbnail'], 1);
  assert.equal(concurrent.records.get('a').photoThumbKey, 'winner');
  assert.deepEqual(concurrent.writes, []);
  const notes = await fixture({ a: plant('a') }, { onGet: ({ records }) => {
    records.get('a').notes.push({ text: 'new note' });
    records.get('a').deletedAt = 'moved-to-trash';
  } });
  assert.equal((await notes.run({ apply: true })).created, 1);
  assert.equal(notes.records.get('a').notes.at(-1).text, 'new note');
  assert.equal(notes.records.get('a').deletedAt, 'moved-to-trash');
});

test('invalid owner/path, missing/corrupt originals and PUT failure affect only their documents', async () => {
  const f = await fixture({
    a: plant('a', { photoKey: keyFor('a', 'foreign') }), b: plant('b', { userId: '' }),
    c: plant('c'), d: plant('d'), e: plant('e'), f: plant('f'),
  }, { beforePut: ({ key }) => { if (key.includes('/e/')) throw new Error(privateUrl); } });
  f.objects.delete(keyFor('c'));
  f.objects.set(keyFor('d'), objectFor(Buffer.from('corrupt-webp')));
  const report = await f.run({ apply: true });
  assert.equal(report.created, 1);
  assert.equal(report.errors, 5);
  assert.equal(report.errorsByCode.PHOTO_KEY_PATH_MISMATCH, 1);
  assert.equal(report.errorsByCode.INVALID_OWNER_UID, 1);
  assert.equal(report.errorsByCode.OBJECT_MISSING, 1);
  assert.equal(report.errorsByCode.INVALID_WEBP, 1);
  assert.equal(report.errorsByCode.THUMBNAIL_UPLOAD_FAILED_OR_OUTCOME_UNKNOWN, 1);
  assert.deepEqual(f.writes.map((write) => write.id), ['f']);
});

test('existing thumbnail mismatches and HEAD access errors never trigger an overwrite', async () => {
  let fail = true;
  const f = await fixture({ a: plant('a') }, { beforeCommit: () => { if (fail) { fail = false; throw new Error(privateUrl); } } });
  await f.run({ apply: true });
  const orphanKey = f.puts()[0].input.Key;
  f.objects.get(orphanKey).Metadata.sha256 = 'wrong';
  assert.equal((await f.run({ apply: true })).errorsByCode.EXISTING_THUMBNAIL_MISMATCH, 1);
  assert.equal(f.puts().length, 1);
  const denied = await fixture({ a: plant('a') }, { onHead: ({ key }) => {
    if (key !== keyFor('a')) throw Object.assign(new Error(privateUrl), { $metadata: { httpStatusCode: 403 } });
  } });
  assert.equal((await denied.run({ apply: true })).errorsByCode.THUMBNAIL_LOOKUP_FAILED, 1);
  assert.deepEqual(denied.puts(), []);
});

test('limit bounds attempts across pages; scan failures and stop-on-error are reported', async () => {
  const initial = Object.fromEntries(Array.from({ length: 205 }, (_, i) => {
    const id = `p${String(i).padStart(3, '0')}`;
    return [id, plant(id)];
  }));
  const f = await fixture(initial);
  const report = await f.run({ limit: 2 });
  assert.equal(report.checked, 205);
  assert.equal(report.attempted, 2);
  assert.equal(report.dryRunPhotos, 2);
  assert.equal(report.deferred, 203);
  assert.equal(report.scanComplete, true);
  const failed = await fixture(initial, { failPage: 2 });
  assert.equal((await failed.run({ limit: 1 })).errorsByCode.FIRESTORE_SCAN_FAILED, 1);
  const stop = await fixture({ a: plant('a', { photoKey: 'wrong' }), b: plant('b') });
  const stopped = await stop.run({ stopOnError: true });
  assert.equal(stopped.checked, 1);
  assert.equal(stopped.scanComplete, false);
  assert.equal(stopped.stopped, true);
});

test('stable keys are source/content/owner scoped and CLI rejection never prints secrets or calls cloud', () => {
  const args = ['PRIVATE_OWNER', 'a', keyFor('a'), Buffer.from('thumb')];
  const key = thumbnailKey(...args);
  assert.equal(thumbnailKey(...args), key);
  assert.notEqual(key, keyFor('a'));
  assert.ok(storage.ownsPhotoKey('PRIVATE_OWNER', 'a', key));
  assert.notEqual(thumbnailKey(args[0], args[1], keyFor('changed'), args[3]), key);
  assert.notEqual(thumbnailKey(args[0], args[1], args[2], Buffer.from('other')), key);
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  for (const script of ['backfill-photo-thumbnails.cjs', 'diagnose-photo-storage.cjs']) {
    for (const [flags, status] of [[['--help'], 0], [['--project', project, '--dry-run'], 1], [['--project', privateUrl], 1]]) {
      const result = spawnSync(process.execPath, [`scripts/${script}`, ...flags], { env, encoding: 'utf8', timeout: 15000 });
      assert.ifError(result.error);
      assert.equal(result.status, status);
      assert.ok(!(result.stdout + result.stderr).includes(privateUrl));
      assert.ok(!result.stderr.includes('Error:'));
    }
  }
});
