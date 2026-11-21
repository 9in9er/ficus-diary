const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FieldValue } = require('firebase-admin/firestore');
const sharp = require('sharp');
const storage = require('../../server/storage.cjs');
const { PROJECT, APPLICATION_COMPATIBILITY, parseArgs, assertCompatibility, resolveCompatibility, approximatePhotoFieldBytes,
  runCleanup, reportExitCode } = require('../../scripts/cleanup-base64-photos.cjs');
const { PRODUCTION_ORIGIN, REQUIRED_FIX_COMMIT, CHECKS } = require('../../scripts/photo-cleanup-production-confirmation.cjs');

const legacy = 'data:image/png;base64,UFJJVkFURV9JTUFHRQ==';
const secret = 'https://private.invalid/?X-Amz-Signature=DO_NOT_LOG_SECRET';
const webp = sharp({ create: { width: 32, height: 24, channels: 3, background: '#729348' } }).webp().toBuffer();
const keyFor = (id, owner = 'PRIVATE_OWNER_A') => `${storage.plantPrefix(owner, id)}photos/12345678-1234-1234-1234-123456789abc.webp`;
const plant = (id, extra = {}) => ({ userId: 'PRIVATE_OWNER_A', photo: legacy, photoKey: keyFor(id),
  deletedAt: null, name: 'PRIVATE_NAME', notes: [{ text: 'private note' }],
  wateringLog: ['2026-11-18'], fertilizingLog: ['2026-11-17'], hidden: false, ...extra });

async function fixture(initial, hooks = {}) {
  const records = new Map(Object.entries(structuredClone(initial)));
  const queries = [];
  const writes = [];
  const commands = [];
  const events = [];
  const bytes = hooks.bytes || await webp;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const headers = { ContentLength: bytes.length, ContentType: 'image/webp', ETag: '"fixture"', Metadata: { sha256 } };
  const snapshot = (id) => {
    const captured = structuredClone(records.get(id));
    return { id, exists: records.has(id), ref: { id, path: `plants/${id}` }, data: () => structuredClone(captured) };
  };
  const query = (state = {}) => ({
    orderBy: (field) => { assert.equal(field, '__name__'); return query(state); },
    limit: (size) => { assert.equal(size, 100); return query({ ...state, size }); },
    select: (...fields) => {
      assert.deepEqual(fields, ['userId', 'photo', 'photoKey', 'deletedAt', '_photoDeleting', 'isWishlisted']);
      return query(state);
    },
    startAfter: (cursor) => query({ ...state, cursor: cursor.id }),
    get: async () => {
      queries.push(state);
      if (queries.length === hooks.failPage) throw new Error(secret);
      const ids = [...records.keys()].sort().filter((id) => !state.cursor || id > state.cursor).slice(0, state.size);
      return { size: ids.length, docs: ids.map(snapshot) };
    },
  });
  const db = {
    collection: (name) => { assert.equal(name, 'plants'); return query(); },
    runTransaction: mock.fn(async (callback) => {
      const pending = [];
      const tx = {
        get: async (ref) => {
          assert.equal(ref.path, `plants/${ref.id}`);
          await hooks.beforeTransactionRead?.(records);
          return snapshot(ref.id);
        },
        update: (ref, patch) => {
          assert.deepEqual(Object.keys(patch), ['photo']);
          assert.equal(patch.photo.isEqual(FieldValue.delete()), true, 'Actual Admin delete sentinel required');
          pending.push(ref.id);
        },
      };
      await callback(tx);
      if (hooks.beforeRetry) {
        pending.length = 0;
        await hooks.beforeRetry(records);
        await callback(tx);
      }
      await hooks.beforeCommit?.();
      for (const id of pending) { delete records.get(id).photo; writes.push(id); }
      await hooks.afterCommit?.();
    }),
  };
  const connection = { bucket: 'fake', client: { send: async (command, options) => {
    const name = command.constructor.name;
    assert.ok(['HeadObjectCommand', 'GetObjectCommand'].includes(name), 'No S3 mutation or signing is allowed');
    assert.ok(options.abortSignal instanceof AbortSignal);
    assert.equal(command.input.Bucket, 'fake');
    commands.push(command);
    if (name === 'HeadObjectCommand') {
      await hooks.onHead?.({ command, records });
      return { ...headers, ...hooks.head };
    }
    assert.equal(command.input.IfMatch, headers.ETag);
    await hooks.onGet?.({ command, records });
    return { ...headers, Body: hooks.body ? hooks.body() : Readable.from([bytes]), ...hooks.get };
  } } };
  const run = async (overrides = {}) => {
    // A compatible FUTURE release is simulated only in memory for deletion tests.
    const report = await runCleanup({ db, connection,
      compatibility: { applyAllowed: true, localPreviewCompatible: true, productionVerified: true },
      options: { project: PROJECT, apply: false, stopOnError: false, ...overrides },
      onResult: (event) => events.push(event) });
    const output = JSON.stringify({ report, events });
    for (const value of [legacy, secret, 'PRIVATE_OWNER', 'PRIVATE_NAME', 'private note', 'plants/', 'X-Amz-Signature']) {
      assert.ok(!output.includes(value));
    }
    return report;
  };
  return { records, queries, writes, commands, events, db, connection, snapshot, run };
}

test('CLI is dry-run by default; explicit apply, limit and stop options are strict and project-bound', () => {
  const args = ['--project', PROJECT];
  assert.deepEqual(parseArgs(args), { project: PROJECT, apply: false, stopOnError: false });
  assert.deepEqual(parseArgs([...args, '--apply', '--limit', '5', '--stop-on-error']),
    { project: PROJECT, apply: true, limit: 5, stopOnError: true });
  assert.equal(parseArgs([...args, '--dry-run']).apply, false);
  assert.equal(parseArgs([...args, '--dry-run', '--include-trash']).includeTrash, true);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const value of ['0', '-1', '1.5', '1e2', 'Infinity', '9007199254740992', '01']) {
    assert.throws(() => parseArgs([...args, '--limit', value]));
  }
  for (const extra of [['--apply', '--dry-run'], ['--apply', '--apply'], ['--limit'], ['--all'],
    ['--user', 'owner'], ['--project', PROJECT], ['--ignore-compatibility'], ['--help']]) {
    assert.throws(() => parseArgs([...args, ...extra]));
  }
  assert.throws(() => parseArgs(['--project', 'another-project']));
  assert.throws(() => parseArgs([]));
});

test('local preview fix does not enable cleanup until the production release is separately verified', async () => {
  assert.equal(Object.isFrozen(APPLICATION_COMPATIBILITY), true);
  assert.equal(APPLICATION_COMPATIBILITY.applyAllowed, false);
  assert.equal(APPLICATION_COMPATIBILITY.localPreviewCompatible, true);
  assert.equal(APPLICATION_COMPATIBILITY.productionVerified, false);
  for (const compatibility of [
    { applyAllowed: true, localPreviewCompatible: true, productionVerified: false },
    { applyAllowed: true, localPreviewCompatible: false, productionVerified: true },
  ]) assert.throws(() => assertCompatibility({ apply: true }, compatibility), { code: 'CLEANUP_BLOCKED_APP_COMPATIBILITY' });
  assert.throws(() => assertCompatibility({ apply: true }), { code: 'CLEANUP_BLOCKED_APP_COMPATIBILITY' });
  const f = await fixture({ a: plant('a') });
  await assert.rejects(runCleanup({ db: f.db, connection: f.connection,
    options: { project: PROJECT, apply: true, stopOnError: false } }), { code: 'CLEANUP_BLOCKED_APP_COMPATIBILITY' });
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.commands, []);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  const dry = await runCleanup({ db: f.db, connection: f.connection,
    options: { project: PROJECT, apply: false, stopOnError: false } });
  assert.equal(dry.dryRunPhotos, 1);
  assert.equal(dry.readyToApply, false);
  assert.equal(dry.applicationBlock, 'PRODUCTION_CONFIRMATION_REQUIRED');
  assert.equal(dry.localPreviewCompatible, true);
  assert.equal(dry.productionVerified, false);
  assert.equal(reportExitCode(dry), 2);
});

test('dry-run fully reads/decodes each candidate object and estimates UTF-8 storage without deleting anything', async () => {
  const initial = { a: plant('a'), b: plant('b', { isWishlisted: true }) };
  const f = await fixture(initial);
  const report = await f.run();
  assert.equal(report.checked, 2);
  assert.equal(report.eligible, 2);
  assert.equal(report.verifiedObjects, 2);
  assert.equal(report.dryRunPhotos, 2);
  assert.equal(report.removed, 0);
  assert.equal(report.estimatedFreedBytes, 0);
  assert.equal(report.estimatedReclaimableBytes, 2 * approximatePhotoFieldBytes(legacy));
  assert.deepEqual(f.commands.map((command) => command.constructor.name),
    ['HeadObjectCommand', 'GetObjectCommand', 'HeadObjectCommand', 'GetObjectCommand']);
  assert.equal(f.db.runTransaction.mock.callCount(), 0);
  assert.deepEqual(Object.fromEntries(f.records), initial);
});

test('multi-owner future-release simulation preserves all unrelated fields and all 47 trash documents, including wishlist', async () => {
  const initial = {
    a: plant('a'), b: plant('b', { userId: 'PRIVATE_OWNER_B', photoKey: keyFor('b', 'PRIVATE_OWNER_B'), isWishlisted: true }),
    c: plant('c', { userId: 'PRIVATE_OWNER_C', photoKey: keyFor('c', 'PRIVATE_OWNER_C') }),
  };
  for (let i = 0; i < 47; i += 1) initial[`trash-${i}`] = plant(`trash-${i}`, { deletedAt: '2026-11-19', isWishlisted: i === 0 });
  const f = await fixture(initial);
  const report = await f.run({ apply: true });
  assert.equal(report.removed, 3);
  assert.equal(report.wishlistRemoved, 1);
  assert.equal(report.skippedByReason.trash, 47);
  assert.equal(report.estimatedFreedBytes, 3 * approximatePhotoFieldBytes(legacy));
  assert.deepEqual(f.writes, ['a', 'b', 'c']);
  for (const [id, original] of Object.entries(initial)) {
    if (id.startsWith('trash')) assert.deepEqual(f.records.get(id), original);
    else {
      const { photo, ...preserved } = original;
      assert.deepEqual(f.records.get(id), preserved);
    }
  }
});

test('trash/deleting/no-key/non-base64/already-cleaned are skipped before touching S3', async () => {
  const initial = {
    a: plant('a', { deletedAt: '2026-11-20' }), b: plant('b', { _photoDeleting: true }),
    c: plant('c', { photoKey: null }), d: plant('d', { photo: null }),
    e: plant('e', { photo: 'https://example.invalid/photo' }), f: plant('f'),
  };
  delete initial.f.photo;
  const f = await fixture(initial);
  const report = await f.run({ apply: true });
  assert.equal(report.skipped, 6);
  assert.equal(report.eligible, 0);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(Object.fromEntries(f.records), initial);
});

test('explicit include-trash cleans only verified base64 and preserves both keys, external URLs and restoration data', async () => {
  const initial = {
    a: plant('a', { photoThumbKey: keyFor('a').replace('12345678-', '22345678-') }),
    b: plant('b', { deletedAt: 'old', isWishlisted: true, photoThumbKey: keyFor('b').replace('12345678-', '22345678-') }),
    c: plant('c', { deletedAt: 'old', photoKey: null }),
    d: plant('d', { deletedAt: 'old', photo: 'https://external/image' }),
    e: plant('e', { deletedAt: 'old', _photoDeleting: true }),
  };
  const f = await fixture(initial);
  const dry = await f.run({ includeTrash: true });
  assert.equal(dry.dryRunPhotos, 2);
  assert.equal(dry.trashEligible, 1);
  assert.deepEqual(Object.fromEntries(f.records), initial);
  const report = await f.run({ apply: true, includeTrash: true });
  assert.equal(report.removed, 2);
  assert.equal(report.includeTrash, true);
  assert.equal(report.trashCandidates, 1);
  assert.equal(report.trashRemoved, 1);
  assert.equal(report.wishlistRemoved, 1);
  assert.equal(report.skipped, 3);
  for (const id of ['a', 'b']) {
    const { photo, ...rest } = initial[id];
    assert.deepEqual(f.records.get(id), rest);
  }
  for (const id of ['c', 'd', 'e']) assert.deepEqual(f.records.get(id), initial[id]);
  assert.equal((await f.run({ apply: true, includeTrash: true })).removed, 0);
  assert.equal(f.writes.length, 2);
});

test('include-trash still rejects a concurrent restore, changed deletion date or deletion lock', async () => {
  for (const change of [
    (records) => { records.get('a').deletedAt = null; },
    (records) => { records.get('a').deletedAt = 'different-date'; },
    (records) => { records.get('a')._photoDeleting = true; },
  ]) {
    const f = await fixture({ a: plant('a', { deletedAt: 'old' }) }, { onGet: ({ records }) => change(records) });
    const report = await f.run({ apply: true, includeTrash: true });
    assert.equal(report.errorsByCode.PLANT_CHANGED, 1);
    assert.equal(f.records.get('a').photo, legacy);
    assert.deepEqual(f.writes, []);
  }
});

test('a thumbnail does not authorize base64 removal when the main object is missing', async () => {
  const thumb = keyFor('a').replace('12345678-', '22345678-');
  const initial = { a: plant('a', { photoThumbKey: thumb, deletedAt: 'old' }) };
  const f = await fixture(initial, { onHead: () => { throw Object.assign(new Error(secret), { $metadata: { httpStatusCode: 404 } }); } });
  const report = await f.run({ apply: true, includeTrash: true });
  assert.equal(report.errorsByCode.OBJECT_MISSING, 1);
  assert.deepEqual(Object.fromEntries(f.records), initial);
  assert.ok(f.commands.every((command) => command.input.Key === keyFor('a')));
  assert.deepEqual(f.writes, []);
});

test('wrong owner/plant path, invalid keys, and missing owner never delete photo or read a foreign object', async () => {
  const f = await fixture({
    a: plant('a', { photoKey: keyFor('a', 'someone-else') }),
    b: plant('b', { photoKey: keyFor('another-plant') }), c: plant('c', { userId: null }),
    d: plant('d', { photoKey: '' }), e: plant('e', { photoKey: secret }),
  });
  const report = await f.run({ apply: true });
  assert.equal(report.errors, 5);
  assert.equal(report.eligible, 0);
  assert.equal(report.candidates, 5);
  assert.equal(report.errorsByCode.PHOTO_KEY_PATH_MISMATCH, 3);
  assert.equal(report.errorsByCode.INVALID_OWNER_UID, 1);
  assert.equal(report.errorsByCode.INVALID_PHOTO_KEY, 1);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.writes, []);
});

test('S3 missing/access/network errors prevent deletion, hide raw errors and allow continuing by default', async () => {
  for (const [status, expected] of [[404, 'OBJECT_MISSING'], [403, 'OBJECT_ACCESS_DENIED'], [500, 'OBJECT_READ_FAILED']]) {
    for (const stage of ['onHead', 'onGet']) {
      const f = await fixture({ a: plant('a'), b: plant('b') }, {
        [stage]: ({ command }) => {
          if (command.input.Key.includes('/a/')) throw Object.assign(new Error(secret), { $metadata: { httpStatusCode: status } });
        },
      });
      const report = await f.run({ apply: true });
      assert.equal(report.errorsByCode[expected], 1);
      assert.equal(report.removed, 1);
      assert.equal(f.records.get('a').photo, legacy);
      assert.equal(f.records.get('b').photo, undefined);
    }
  }
});

test('wrong MIME, corrupt WebP, truncated body and checksum mismatch never remove base64', async () => {
  for (const [hooks, code] of [
    [{ head: { ContentType: 'image/png' } }, 'INVALID_CONTENT_TYPE'],
    [{ head: { ContentLength: 0 } }, 'INVALID_OBJECT_SIZE'],
    [{ bytes: Buffer.from('RIFF0000WEBPinvalid') }, 'INVALID_WEBP'],
    [{ body: () => Readable.from([Buffer.alloc(1)]) }, 'OBJECT_SIZE_MISMATCH'],
    [{ get: { Metadata: { sha256: 'wrong' } } }, 'CHECKSUM_MISMATCH'],
  ]) {
    const f = await fixture({ a: plant('a') }, hooks);
    const report = await f.run({ apply: true });
    assert.equal(report.errorsByCode[code], 1);
    assert.equal(report.removed, 0);
    assert.equal(f.records.get('a').photo, legacy);
    assert.deepEqual(f.writes, []);
  }
});

test('every document guard is rechecked in transaction after S3 verification', async () => {
  for (const change of [
    (records) => records.get('a').userId = 'another-owner',
    (records) => records.get('a').photo = 'changed',
    (records) => records.get('a').photoKey = keyFor('a', 'another-owner'),
    (records) => records.get('a').deletedAt = '2026-11-20',
    (records) => records.get('a')._photoDeleting = true,
    (records) => records.delete('a'),
  ]) {
    const f = await fixture({ a: plant('a') }, { onGet: ({ records }) => change(records) });
    const report = await f.run({ apply: true });
    assert.equal(report.errors, 1);
    assert.equal(report.verifiedObjects, 1);
    assert.equal(report.removed, 0);
    assert.equal(report.estimatedFreedBytes, 0);
    assert.deepEqual(f.writes, []);
  }
});

test('an unrelated concurrent note edit survives deletion; changing guarded fields on retry aborts', async () => {
  const f = await fixture({ a: plant('a') }, { onGet: ({ records }) => { records.get('a').notes.push({ text: 'new note' }); } });
  assert.equal((await f.run({ apply: true })).removed, 1);
  assert.equal(f.records.get('a').notes.at(-1).text, 'new note');
  const retry = await fixture({ a: plant('a') }, { beforeRetry: (records) => { records.get('a').deletedAt = '2026-11-20'; } });
  assert.equal((await retry.run({ apply: true })).errorsByCode.PLANT_CHANGED, 1);
  assert.deepEqual(retry.writes, []);
  assert.equal(retry.records.get('a').photo, legacy);
});

test('limit 5 bounds candidate attempts across pages, skips do not consume it, processing is sequential and resume skips deletions', async () => {
  const initial = { '000-trash': plant('000-trash', { deletedAt: '2026-11-20' }) };
  for (let i = 0; i < 111; i += 1) {
    const id = `p${String(i).padStart(3, '0')}`;
    initial[id] = plant(id);
  }
  let active = 0;
  let maximum = 0;
  const f = await fixture(initial, { onGet: async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  } });
  const first = await f.run({ apply: true, limit: 5 });
  assert.equal(first.checked, 112);
  assert.equal(first.candidates, 111);
  assert.equal(first.eligible, 5);
  assert.equal(first.attempted, 5);
  assert.equal(first.removed, 5);
  assert.equal(first.deferred, 106);
  assert.equal(first.scanComplete, true);
  assert.equal(f.queries.length, 2);
  assert.equal(f.commands.length, 10);
  const rest = await f.run({ apply: true });
  assert.equal(rest.removed, 106);
  assert.equal(rest.skippedByReason['no-base64'], 5);
  assert.equal(rest.skippedByReason.trash, 1);
  const count = f.commands.length;
  assert.equal((await f.run({ apply: true })).removed, 0);
  assert.equal(f.commands.length, count);
  assert.equal(f.writes.length, 111);
  assert.equal(maximum, 1);
  assert.equal(f.records.get('000-trash').photo, legacy);
});

test('errors consume limited attempts and --stop-on-error stops immediately', async () => {
  const f = await fixture({ a: plant('a'), b: plant('b'), c: plant('c') }, { onHead: () => { throw new Error(secret); } });
  const limited = await f.run({ apply: true, limit: 1 });
  assert.equal(limited.errors, 1);
  assert.equal(limited.attempted, 1);
  assert.equal(limited.deferred, 2);
  assert.equal(limited.scanComplete, true);
  const stopped = await f.run({ apply: true, stopOnError: true });
  assert.equal(stopped.checked, 1);
  assert.equal(stopped.errors, 1);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.scanComplete, false);
  assert.equal(reportExitCode(stopped), 1);
});

test('page failure preserves partial counts and cannot claim a complete cleanup', async () => {
  const initial = Object.fromEntries(Array.from({ length: 101 }, (_, i) => {
    const id = `p${String(i).padStart(3, '0')}`;
    return [id, plant(id)];
  }));
  const f = await fixture(initial, { failPage: 2 });
  const report = await f.run({ limit: 1 });
  assert.equal(report.checked, 100);
  assert.equal(report.scanComplete, false);
  assert.equal(report.errorsByCode.FIRESTORE_SCAN_FAILED, 1);
  assert.equal(report.removed, 0);
});

test('commit failure retains base64; lost commit response is reported as ambiguous and safely skipped on rerun', async () => {
  const before = await fixture({ a: plant('a') }, { beforeCommit: () => { throw new Error(secret); } });
  assert.equal((await before.run({ apply: true })).errorsByCode.FIRESTORE_FAILED_OR_OUTCOME_UNKNOWN, 1);
  assert.equal(before.records.get('a').photo, legacy);
  let fail = true;
  const after = await fixture({ a: plant('a') }, { afterCommit: () => { if (fail) { fail = false; throw new Error(secret); } } });
  const ambiguous = await after.run({ apply: true });
  assert.equal(ambiguous.removed, 0);
  assert.equal(ambiguous.estimatedFreedBytes, 0);
  assert.equal(ambiguous.errors, 1);
  assert.equal(after.records.get('a').photo, undefined);
  assert.equal((await after.run({ apply: true })).skippedByReason['no-base64'], 1);
  assert.equal(after.writes.length, 1);
});

test('CLI help and dry-run initialization/argument failures expose no secret; no actual apply process runs', () => {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  for (const [args, status] of [[['--help'], 0], [['--project', PROJECT, '--dry-run'], 1], [['--project', secret], 1]]) {
    const result = spawnSync(process.execPath, ['scripts/cleanup-base64-photos.cjs', ...args], { env, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, status);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.ok(!(result.stdout + result.stderr).includes('Error:'));
  }
});

test('a valid acknowledged receipt still cannot authorize deleting a missing object or a changed document', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ficus-confirmation-guards-'));
  const file = path.join(folder, 'production.json');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: PROJECT,
    productionOrigin: PRODUCTION_ORIGIN, fixCommit: REQUIRED_FIX_COMMIT,
    deployment: 'dpl_ProductionFixture123', sourceCommit: 'a'.repeat(40), confirmedAt: new Date().toISOString(),
    checks: Object.fromEntries(CHECKS.map((check) => [check, true])) }));
  await fs.writeFile(file, bytes);
  t.after(async () => {
    assert.equal(path.dirname(folder), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('ficus-confirmation-guards-'));
    await fs.unlink(file);
    await fs.rmdir(folder);
  });
  const options = { project: PROJECT, apply: true, stopOnError: true, limit: 5,
    productionConfirmation: file, confirmProduction: createHash('sha256').update(bytes).digest('hex') };
  const compatibility = await resolveCompatibility(options);
  assert.equal(compatibility.productionVerified, true);
  for (const hooks of [
    { onHead: () => { throw Object.assign(new Error(secret), { $metadata: { httpStatusCode: 404 } }); } },
    { onGet: ({ records }) => { records.get('a').photoKey = keyFor('replacement'); } },
  ]) {
    const f = await fixture({ a: plant('a'), trash: plant('trash', { deletedAt: '2026-11-20' }) }, hooks);
    const report = await runCleanup({ db: f.db, connection: f.connection, options, compatibility });
    assert.equal(report.errors, 1);
    assert.equal(report.removed, 0);
    assert.equal(report.productionVerified, true);
    assert.equal(f.records.get('a').photo, legacy);
    assert.equal(f.records.get('trash').photo, legacy);
    assert.deepEqual(f.writes, []);
  }
});
