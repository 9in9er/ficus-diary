const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const storage = require('../../server/storage.cjs');
const { PROJECT, TARGETS, parseArgs, runTargetedMigration } = require('../../scripts/migrate-remaining-photos.cjs');

const [firstId, secondId] = TARGETS;
const secret = 'https://secret.invalid/?X-Amz-Signature=PRIVATE_CREDENTIAL';
const base64 = 'data:image/png;base64,UFJJVkFURV9JTUFHRQ==';
const initial = () => ({
  [firstId]: { userId: 'PRIVATE_OWNER_A', photo: base64, deletedAt: null, name: 'PRIVATE_NAME_A', pinned: true },
  [secondId]: { userId: 'PRIVATE_OWNER_B', photo: base64, name: 'PRIVATE_NAME_B', isWishlisted: true },
  unrelated: { userId: 'PRIVATE_OWNER_C', photo: base64, photoKey: 'untouched' },
});

function fixture(records = initial(), hooks = {}) {
  const data = new Map(Object.entries(structuredClone(records)));
  const reads = [];
  const transactionReads = [];
  const writes = [];
  const objects = new Map();
  const commands = [];
  const events = [];
  const allowed = (id) => assert.ok(TARGETS.includes(id), 'No other plant may be touched');
  const ref = (id) => ({ id, path: `plants/${id}`, get: async () => {
    allowed(id);
    reads.push(id);
    await hooks.onRead?.({ id, reads, data });
    return snapshot(id);
  } });
  const snapshot = (id) => {
    const captured = structuredClone(data.get(id));
    return { id, ref: ref(id), exists: data.has(id), data: () => structuredClone(captured) };
  };
  const db = {
    collection: (name) => {
      assert.equal(name, 'plants');
      // No query/list methods. Reading any wider scope fails the test.
      return { doc: (id) => { allowed(id); return ref(id); } };
    },
    runTransaction: mock.fn(async (callback) => {
      const pending = [];
      const transaction = {
        get: async (documentRef) => {
          allowed(documentRef.id);
          transactionReads.push(documentRef.id);
          await hooks.beforeTransactionRead?.({ id: documentRef.id, data });
          return snapshot(documentRef.id);
        },
        update: (documentRef, patch) => {
          allowed(documentRef.id);
          assert.deepEqual(Object.keys(patch), ['photoKey']);
          assert.ok(storage.ownsPhotoKey(data.get(documentRef.id).userId, documentRef.id, patch.photoKey));
          pending.push({ id: documentRef.id, patch });
        },
      };
      await callback(transaction);
      if (hooks.beforeRetry) {
        await hooks.beforeRetry(data);
        pending.length = 0;
        await callback(transaction);
      }
      await hooks.beforeCommit?.();
      for (const entry of pending) {
        writes.push(entry);
        data.set(entry.id, { ...data.get(entry.id), ...entry.patch });
      }
      await hooks.afterCommit?.();
    }),
  };
  const client = { send: async (command) => {
    const name = command.constructor.name;
    assert.ok(['HeadObjectCommand', 'PutObjectCommand'].includes(name), 'No deletion/listing/signing');
    commands.push(command);
    const { Key } = command.input;
    if (name === 'HeadObjectCommand') {
      await hooks.onHead?.();
      if (objects.has(Key)) return structuredClone(objects.get(Key));
      throw Object.assign(new Error(secret), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    }
    await hooks.onPut?.({ command, data });
    objects.set(Key, { ContentLength: command.input.Body.length, ContentType: command.input.ContentType,
      Metadata: command.input.Metadata });
    await hooks.afterPut?.({ command, data });
    return {};
  } };
  const files = { storeMigrationPhoto: mock.fn(async (uid, id, bytes) => {
    allowed(id);
    assert.equal(uid, data.get(id).userId);
    return storage.storeMigrationPhoto(uid, id, bytes, { client, bucket: 'fake' });
  }) };
  const convert = mock.fn(async (photo) => {
    await hooks.onConvert?.({ photo, data });
    return Buffer.from('converted:' + photo);
  });
  const run = async (apply = false, overrides = {}) => {
    const report = await runTargetedMigration({ db, files, convert, options: { project: PROJECT, apply },
      onResult: (result) => events.push(result), ...overrides });
    const output = JSON.stringify({ report, events });
    for (const value of [base64, secret, 'PRIVATE_OWNER', 'PRIVATE_NAME', 'plants/', 'X-Amz-Signature']) {
      assert.ok(!output.includes(value), `Output must not contain ${value.slice(0, 15)}`);
    }
    return report;
  };
  const puts = () => commands.filter((command) => command.constructor.name === 'PutObjectCommand');
  return { data, reads, transactionReads, writes, objects, commands, events, db, files, convert, run, puts };
}

test('CLI is bound to the exact project and fixed immutable two-document scope; defaults to dry-run', () => {
  const args = ['--project', PROJECT];
  assert.deepEqual(parseArgs(args), { project: PROJECT, apply: false });
  assert.deepEqual(parseArgs([...args, '--dry-run']), { project: PROJECT, apply: false });
  assert.deepEqual(parseArgs([...args, '--apply']), { project: PROJECT, apply: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.equal(Object.isFrozen(TARGETS), true);
  assert.deepEqual(TARGETS, ['mnV2BvHKuxE7XZr5mp1B', 'yJ8a7aS3fLK0tb3dfqkM']);
  for (const extra of [['--all'], ['--user', 'someone'], ['--plant', 'another'], ['--limit', '2'],
    ['--targets', firstId], ['--apply', '--dry-run'], ['--apply', '--apply'], ['--project', PROJECT], ['--help']]) {
    assert.throws(() => parseArgs([...args, ...extra]));
  }
  assert.throws(() => parseArgs(['--project', 'another-project', '--apply']));
  assert.throws(() => parseArgs(['--apply']));
  assert.throws(() => parseArgs(['--project']));
});

test('programmatic scope overrides and non-boolean apply fail before any read', async () => {
  const f = fixture();
  for (const options of [{ project: PROJECT, apply: 'false' }, { project: PROJECT, apply: true, targets: ['another'] },
    { project: 'another-project', apply: false }, { project: PROJECT, apply: true, user: 'someone' }]) {
    await assert.rejects(runTargetedMigration({ db: f.db, options }));
  }
  assert.deepEqual(f.reads, []);
});

test('dry-run reads exactly two IDs, uses real local WebP conversion, and makes no S3/transaction calls', async () => {
  const records = initial();
  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'green' } }).png().toBuffer();
  for (const id of TARGETS) records[id].photo = 'data:image/png;base64,' + png.toString('base64');
  const f = fixture(records);
  const { convertLegacyPhoto } = require('../../scripts/migrate-photos.cjs');
  const report = await f.run(false, { convert: convertLegacyPhoto });
  assert.deepEqual(f.reads, TARGETS);
  assert.equal(report.eligible, 2);
  assert.equal(report.dryRunPhotos, 2);
  assert.equal(report.migrated, 0);
  assert.equal(report.errors, 0);
  assert.equal(report.uploadedBytes, 0);
  assert.equal(report.preflightPassed, true);
  assert.equal(report.readyToApply, true);
  assert.equal(report.completed, true);
  assert.ok(report.estimatedBytes > 0);
  assert.equal(f.files.storeMigrationPhoto.mock.callCount(), 0);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(Object.fromEntries(f.data), records);
});

test('simulated apply derives two different owners and only adds photoKey to those two documents', async () => {
  const records = initial();
  const f = fixture(records);
  const report = await f.run(true);
  assert.equal(report.migrated, 2);
  assert.equal(report.completed, true);
  assert.equal(report.errors, 0);
  assert.deepEqual(f.reads, [firstId, secondId, firstId, secondId]);
  assert.deepEqual(f.transactionReads, TARGETS);
  assert.deepEqual(f.files.storeMigrationPhoto.mock.calls.map((call) => call.arguments.slice(0, 2)),
    [['PRIVATE_OWNER_A', firstId], ['PRIVATE_OWNER_B', secondId]]);
  for (const id of TARGETS) {
    const { photoKey, ...rest } = f.data.get(id);
    assert.ok(storage.ownsPhotoKey(records[id].userId, id, photoKey));
    assert.deepEqual(rest, records[id]);
  }
  assert.deepEqual(f.data.get('unrelated'), records.unrelated);
  assert.equal(f.writes.length, 2);
  assert.equal(f.puts().length, 2);
  assert.equal(report.uploadedBytes, report.estimatedBytes);
});

test('preflight of both documents is required before any upload, including failure in the second document', async () => {
  for (const [patch, code] of [
    [{ userId: null }, 'INVALID_OWNER_UID'], [{ userId: ' ' }, 'INVALID_OWNER_UID'],
    [{ userId: 'x'.repeat(129) }, 'INVALID_OWNER_UID'],
    [{ deletedAt: '2026-11-20' }, 'PLANT_IN_TRASH'], [{ _photoDeleting: true }, 'PHOTO_DELETION_IN_PROGRESS'],
    [{ photo: null }, 'NO_BASE64_PHOTO'], [{ photo: 'https://example.invalid/photo' }, 'NO_BASE64_PHOTO'],
    [{ photoKey: '' }, 'INVALID_EXISTING_PHOTO_KEY'], [{ photoKey: { sensitive: secret } }, 'INVALID_EXISTING_PHOTO_KEY'],
    [{ photoKey: storage.migrationPhotoKey('another-owner', secondId, Buffer.from('other')) }, 'INVALID_EXISTING_PHOTO_KEY'],
  ]) {
    const records = initial();
    Object.assign(records[secondId], patch);
    const f = fixture(records);
    const report = await f.run(true);
    assert.equal(report.preflightPassed, false);
    assert.equal(report.completed, false);
    assert.equal(report.attempted, 0);
    assert.equal(report.errors, 1);
    assert.equal(report.results[1].code, code);
    assert.equal(report.results[0].status, 'not-applied');
    assert.equal(f.files.storeMigrationPhoto.mock.callCount(), 0);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(Object.fromEntries(f.data), records);
  }
});

test('missing/read-failed documents, unreadable source photos and out-of-scope snapshots fail closed', async () => {
  const records = initial();
  delete records[secondId];
  const missing = fixture(records);
  assert.equal((await missing.run(true)).results[1].code, 'PLANT_NOT_FOUND');
  assert.equal(missing.puts().length, 0);
  const readFailed = fixture(initial(), { onRead: ({ id }) => { if (id === secondId) throw new Error(secret); } });
  assert.equal((await readFailed.run(true)).results[1].code, 'FIRESTORE_READ_FAILED');
  assert.equal(readFailed.puts().length, 0);
  const broken = fixture(initial(), { onConvert: () => { throw new Error(secret); } });
  assert.equal((await broken.run(true)).results[0].code, 'CONVERSION_FAILED');
  assert.equal(broken.puts().length, 0);
  const rogueDb = { collection: () => ({ doc: (id) => ({ id, path: 'plants/unrelated', get: () => assert.fail('Scope must fail before GET') }) }) };
  const report = await runTargetedMigration({ db: rogueDb, options: { project: PROJECT, apply: true } });
  assert.equal(report.errors, 2);
  assert.ok(report.results.every((result) => result.code === 'DOCUMENT_SCOPE_MISMATCH'));
});

test('changes during conversion are reread and blocked before the first S3 operation', async () => {
  for (const change of [
    (data) => data.get(firstId).userId = 'another-owner',
    (data) => data.get(firstId).photo = 'data:image/png;base64,Y2hhbmdlZA==',
    (data) => data.get(firstId).photoKey = '',
    (data) => data.get(firstId).photoKey = 'new-key',
    (data) => data.get(firstId).deletedAt = '2026-11-20',
    (data) => data.get(firstId)._photoDeleting = true,
    (data) => data.delete(firstId),
  ]) {
    let changed = false;
    const f = fixture(initial(), { onConvert: ({ data }) => { if (!changed) { change(data); changed = true; } } });
    const report = await f.run(true);
    assert.equal(report.errors, 1);
    assert.equal(report.migrated, 0);
    assert.equal(report.notApplied, 1);
    assert.equal(f.commands.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('transaction rechecks owner/photo/key/trash/lock/existence after upload, including malformed new key', async () => {
  for (const change of [
    (data) => data.get(firstId).userId = 'another-owner',
    (data) => data.get(firstId).photo = 'changed',
    (data) => data.get(firstId).photoKey = '',
    (data) => data.get(firstId).photoKey = 'new-key',
    (data) => data.get(firstId).deletedAt = '2026-11-20',
    (data) => data.get(firstId)._photoDeleting = true,
    (data) => data.delete(firstId),
  ]) {
    const f = fixture(initial(), { afterPut: ({ data }) => change(data) });
    const report = await f.run(true);
    assert.equal(report.errors, 1);
    assert.equal(report.migrated, 0);
    assert.equal(report.notApplied, 1);
    assert.ok(report.uploadedBytes > 0);
    assert.equal(f.puts().length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.data.get(secondId).photoKey, undefined);
  }
});

test('a transaction retry repeats guards rather than committing a previously validated patch', async () => {
  const f = fixture(initial(), { beforeRetry: (data) => { data.get(firstId)._photoDeleting = true; } });
  const report = await f.run(true);
  assert.equal(report.errors, 1);
  assert.equal(report.migrated, 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.transactionReads, [firstId, firstId]);
});

test('repeated simulated apply skips the already stored keys without further uploads or conversions', async () => {
  const f = fixture();
  assert.equal((await f.run(true)).migrated, 2);
  const calls = f.convert.mock.callCount();
  const retry = await f.run(true);
  assert.equal(retry.alreadyMigrated, 2);
  assert.equal(retry.eligible, 0);
  assert.equal(retry.migrated, 0);
  assert.equal(retry.uploadedBytes, 0);
  assert.equal(retry.completed, true);
  assert.equal(f.puts().length, 2);
  assert.equal(f.writes.length, 2);
  assert.equal(f.convert.mock.callCount(), calls);
});

test('a failed commit leaves source intact and retry reuses the deterministic object', async () => {
  let fail = true;
  const f = fixture(initial(), { beforeCommit: () => { if (fail) throw new Error(secret); } });
  const first = await f.run(true);
  assert.equal(first.results[0].code, 'FIRESTORE_FAILED');
  assert.equal(first.notApplied, 1);
  assert.equal(first.migrated, 0);
  assert.equal(f.data.get(firstId).photoKey, undefined);
  assert.equal(f.data.get(firstId).photo, base64);
  assert.equal(f.objects.size, 1);
  fail = false;
  const retry = await f.run(true);
  assert.equal(retry.migrated, 2);
  assert.equal(retry.reusedObjects, 1);
  assert.equal(f.puts().length, 2);
});

test('lost upload/commit responses resume without duplicate uploads or deleting old base64', async () => {
  for (const phase of ['afterPut', 'afterCommit']) {
    let fail = true;
    const f = fixture(initial(), { [phase]: () => { if (fail) { fail = false; throw new Error(secret); } } });
    assert.equal((await f.run(true)).errors, 1);
    const retry = await f.run(true);
    assert.equal(retry.errors, 0);
    assert.equal(retry.completed, true);
    assert.equal(f.puts().length, 2);
    for (const id of TARGETS) assert.equal(f.data.get(id).photo, base64);
  }
});

test('S3 access/mismatch failures never overwrite objects or continue to the next upload', async () => {
  const denied = fixture(initial(), { onHead: () => { throw new Error(secret); } });
  const report = await denied.run(true);
  assert.equal(report.results[0].code, 'STORAGE_FAILED');
  assert.equal(report.notApplied, 1);
  assert.equal(denied.puts().length, 0);
  const mismatch = fixture();
  const bytes = Buffer.from('converted:' + base64);
  const key = storage.migrationPhotoKey('PRIVATE_OWNER_A', firstId, bytes);
  mismatch.objects.set(key, { ContentLength: bytes.length, ContentType: 'image/webp', Metadata: { sha256: 'wrong' } });
  assert.equal((await mismatch.run(true)).results[0].code, 'STORAGE_FAILED');
  assert.equal(mismatch.puts().length, 0);
  assert.equal(mismatch.writes.length, 0);
});

test('CLI help/config/argument diagnostics hide sensitive values; no live apply process is launched', () => {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  for (const [args, expected] of [[['--help'], 0], [['--project', PROJECT, '--dry-run'], 1],
    [['--project', secret], 1], [['--project', PROJECT, '--user', secret], 1]]) {
    const result = spawnSync(process.execPath, ['scripts/migrate-remaining-photos.cjs', ...args], {
      env, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.ok(!(result.stdout + result.stderr).includes('Error:'));
  }
});
