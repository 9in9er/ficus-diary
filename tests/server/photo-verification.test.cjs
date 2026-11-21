const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { plantPrefix, MAX_PHOTO_BYTES } = require('../../server/storage.cjs');
const { parseArgs, assertProject, createStorageReader, decodeWebP, verifyObject,
  runVerification, reportExitCode } = require('../../scripts/verify-photos.cjs');

const project = 'my-plants-app-8f6fc';
const legacy = 'data:image/png;base64,DO_NOT_LOG_BASE64';
const secret = 'https://example.invalid/?X-Amz-Signature=DO_NOT_LOG_SECRET';
const webp = sharp({ create: { width: 32, height: 24, channels: 3, background: '#729348' } }).webp().toBuffer();
const keyFor = (id, uid = 'owner') => `${plantPrefix(uid, id)}photos/12345678-1234-1234-1234-123456789abc.webp`;
const plant = (id, extra = {}) => ({ userId: 'owner', photoKey: keyFor(id), ...extra });
const sdkError = (status, name = 'S3Error') => Object.assign(new Error(secret), {
  name, $metadata: { httpStatusCode: status },
});

// Only in-memory objects and real local image decoding. No env files, SDK network or credentials.
async function storageFixture({ bytes, head = {}, get = {}, onHead, onGet, makeBody } = {}) {
  bytes ??= await webp;
  const commands = [];
  const bodies = [];
  const metadata = { sha256: createHash('sha256').update(bytes).digest('hex') };
  const headers = { ContentLength: bytes.length, ContentType: 'image/webp', ETag: '"fixture-etag"', Metadata: metadata };
  const client = { send: async (command, options) => {
    const name = command.constructor.name;
    assert.ok(['HeadObjectCommand', 'GetObjectCommand'].includes(name), 'Only read commands are permitted');
    assert.equal(command.input.Bucket, 'fake-bucket');
    assert.ok(options.abortSignal instanceof AbortSignal);
    commands.push(command);
    if (name === 'HeadObjectCommand') {
      await onHead?.(command);
      return { ...headers, ...head };
    }
    assert.equal(command.input.IfMatch, headers.ETag);
    await onGet?.(command);
    const body = Object.hasOwn(get, 'Body') ? get.Body
      : makeBody ? makeBody() : Readable.from([bytes.subarray(0, 12), bytes.subarray(12)]);
    if (body) bodies.push(body);
    return { ...headers, Body: body, ...get };
  } };
  return { connection: { client, bucket: 'fake-bucket' }, commands, bodies };
}

function firestoreFixture(records, { failPage } = {}) {
  const original = structuredClone(records);
  const queries = [];
  const query = (state = {}) => ({
    orderBy: (field) => { assert.equal(field, '__name__'); return query(state); },
    limit: (size) => { assert.equal(size, 100); return query({ ...state, size }); },
    select: (...fields) => {
      assert.deepEqual(fields, ['userId', 'photo', 'photoKey', 'deletedAt', '_photoDeleting']);
      return query({ ...state, selected: true });
    },
    startAfter: (snapshot) => query({ ...state, cursor: snapshot.id }),
    get: async () => {
      assert.equal(state.selected, true);
      queries.push(state);
      if (queries.length === failPage) throw new Error(secret);
      const ids = Object.keys(records).sort().filter((id) => !state.cursor || id > state.cursor).slice(0, state.size);
      return { size: ids.length, docs: ids.map((id) => ({ id, data: () => structuredClone(records[id]) })) };
    },
  });
  // No write methods: any attempted write or transaction fails the test.
  const db = { collection: (name) => { assert.equal(name, 'plants'); return query(); } };
  return { db, queries, assertUnchanged: () => assert.deepEqual(records, original) };
}

async function audit(records, { storageOptions, firestoreOptions, options = {} } = {}) {
  const files = await storageFixture(storageOptions);
  const firestore = firestoreFixture(records, firestoreOptions);
  const events = [];
  const report = await runVerification({ db: firestore.db, connection: files.connection,
    options: { project, ...options }, onResult: (result) => events.push(result) });
  firestore.assertUnchanged();
  const output = JSON.stringify({ report, events });
  assert.ok(!output.includes(legacy));
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('X-Amz-Signature'));
  assert.ok(!output.includes('plants/')); // Object keys are never logged either.
  return { report, events, ...files, ...firestore };
}

test('CLI scans all plants; rejects write flags, scope truncation, duplicates and unsafe values', () => {
  const args = ['--project', project];
  assert.deepEqual(parseArgs(args), { project });
  assert.deepEqual(parseArgs([...args, '--expect-photo-keys', '12']), { project, expectPhotoKeys: 12 });
  assert.equal(parseArgs([...args, '--expect-photo-keys', '0']).expectPhotoKeys, 0);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const flag of ['--apply', '--delete', '--cleanup', '--dry-run', '--limit', '--user', '--plant', '--help',
    '--expect-trash-base64', '--confirmation', '__proto__', 'constructor', 'toString']) {
    assert.throws(() => parseArgs([...args, flag, '1']));
  }
  for (const value of ['-1', '1.5', '1e2', '9007199254740992', secret]) {
    assert.throws(() => parseArgs([...args, '--expect-photo-keys', value]));
  }
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--project']));
  assert.throws(() => parseArgs(['--project', secret]));
  assert.throws(() => parseArgs([...args, ...args]));
  assert.throws(() => parseArgs([...args, '--expect-photo-keys']));
  assert.throws(() => parseArgs([...args, '--expect-photo-keys', '1', '--expect-photo-keys', '1']));
});

test('project/database and Yandex endpoint checks happen before any cloud reads', () => {
  const env = { FIREBASE_PROJECT_ID: project };
  const firebase = { auth: { app: { options: { projectId: project } } },
    db: { projectId: project, databaseId: '(default)' } };
  assert.doesNotThrow(() => assertProject(project, env, firebase));
  assert.throws(() => assertProject('other-project', env), /PROJECT_MISMATCH/);
  for (const name of ['REACT_APP_FIREBASE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    assert.throws(() => assertProject(project, { ...env, [name]: 'other' }), /PROJECT_MISMATCH/);
  }
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    assert.throws(() => assertProject(project, { ...env, [name]: 'localhost' }), /EMULATOR/);
  }
  assert.throws(() => assertProject(project, env, { ...firebase,
    db: { projectId: project, databaseId: 'other' } }), /PROJECT_MISMATCH/);
  assert.throws(() => assertProject(project, env, { ...firebase,
    db: { projectId: 'other', databaseId: '(default)' } }), /PROJECT_MISMATCH/);
  assert.throws(() => assertProject(project, env, { ...firebase,
    auth: { app: { options: { projectId: 'other' } } } }), /PROJECT_MISMATCH/);
  assert.throws(() => createStorageReader({}), /STORAGE_NOT_CONFIGURED/);
  for (const endpoint of ['http://storage.yandexcloud.net', 'https://attacker.invalid', secret,
    'https://storage.yandexcloud.net@attacker.invalid', 'https://storage.yandexcloud.net/?secret=1']) {
    assert.throws(() => createStorageReader({ YANDEX_BUCKET_NAME: 'bucket', YANDEX_S3_ENDPOINT: endpoint,
      YANDEX_ACCESS_KEY_ID: 'fake', YANDEX_SECRET_ACCESS_KEY: 'fake' }), /UNEXPECTED_STORAGE_ENDPOINT/);
  }
});

test('bulk integrity check includes all owners, wishlist, trash and plants without photos, and only reads', async () => {
  const records = {};
  for (let i = 0; i < 205; i += 1) {
    const id = `plant-${String(i).padStart(3, '0')}`;
    const uid = i === 5 ? 'second-owner' : 'owner';
    records[id] = plant(id, { userId: uid, photoKey: keyFor(id, uid), isWishlisted: i === 3,
      deletedAt: i === 4 ? '2026-11-19' : null });
  }
  records.withoutPhoto = { userId: 'owner' };
  records.wishWithoutPhoto = { userId: 'owner', isWishlisted: true, photoKey: null };
  records.trashWithoutPhoto = { userId: 'owner', deletedAt: '2026-11-19' };
  const { report, commands, queries } = await audit(records, { options: { expectPhotoKeys: 205 } });
  assert.equal(report.totalDocuments, 208);
  assert.equal(report.verified, 205);
  assert.equal(report.attemptedObjects, 205);
  assert.equal(report.withoutPhotoKey, 3);
  assert.equal(report.trashPlants, 2);
  assert.equal(report.legacyPhotoFields, 0);
  assert.equal(report.errors, 0);
  assert.equal(report.potentialProblems, 0);
  assert.equal(report.failedPhotoKeys, 0);
  assert.equal(report.scanComplete, true);
  assert.equal(report.checksPassed, true);
  assert.equal(reportExitCode(report), 0);
  assert.equal(report.verifiedBytes, 205 * (await webp).length);
  assert.equal(commands.length, 410);
  assert.equal(queries.length, 3);
  assert.equal(queries[1].cursor, Object.keys(records).sort()[99]);
});

test('audit accepts historical migration keys without regenerating them', async () => {
  const photoKey = `${plantPrefix('owner', 'plant-1')}photos/b3d652ac-7074-4921-6e0d-7c6722eeac98.webp`;
  const { report, commands } = await audit({ 'plant-1': plant('plant-1', { photoKey }) });
  assert.equal(report.verified, 1);
  assert.equal(report.checksPassed, true);
  assert.equal(reportExitCode(report), 0);
  assert.deepEqual(commands.map((command) => [command.constructor.name, command.input.Key]), [
    ['HeadObjectCommand', photoKey], ['GetObjectCommand', photoKey],
  ]);
});

test('HEAD is followed by conditional GET and full WebP decoding; optional old-upload checksum is accepted', async () => {
  const files = await storageFixture({ head: { Metadata: undefined }, get: { Metadata: undefined } });
  const result = await verifyObject({ ...files.connection, key: keyFor('a') });
  assert.deepEqual(result, { bytes: (await webp).length, width: 32, height: 24 });
  assert.deepEqual(files.commands.map((command) => command.constructor.name), ['HeadObjectCommand', 'GetObjectCommand']);
  assert.ok(files.bodies.every((body) => body.destroyed));
});

test('wrong UID, plant ID, directory, suffix, malformed keys/owners never read another object', async () => {
  const records = {
    a: plant('a', { photoKey: keyFor('a', 'wrong-owner') }),
    b: plant('b', { photoKey: keyFor('another-plant') }),
    c: plant('c', { photoKey: keyFor('c').replace('photos/', 'uploads/') }),
    d: plant('d', { photoKey: `${keyFor('d')}/../../other` }),
    e: plant('e', { photoKey: secret }),
    f: plant('f', { photoKey: '' }),
    g: plant('g', { photoKey: { secret } }),
    h: plant('h', { userId: null }),
    i: plant('i', { userId: ' ' }),
    j: plant('j', { userId: 'x'.repeat(129) }),
    [secret]: plant('valid'),
  };
  const { report, commands } = await audit(records);
  assert.equal(report.errors, 11);
  assert.equal(report.failedPhotoKeys, 11);
  assert.equal(report.errorsByCode.PHOTO_KEY_PATH_MISMATCH, 5);
  assert.equal(report.errorsByCode.INVALID_PHOTO_KEY, 2);
  assert.equal(report.errorsByCode.INVALID_OWNER_UID, 3);
  assert.equal(report.errorsByCode.INVALID_PLANT_ID, 1);
  assert.equal(commands.length, 0);
  assert.equal(report.verified, 0);
});

test('missing objects, access denied, changed objects and read failures are distinct; processing continues', async () => {
  for (const stage of ['onHead', 'onGet']) {
    for (const [error, code] of [
      [sdkError(404), 'OBJECT_MISSING'],
      [sdkError(undefined, 'NoSuchKey'), 'OBJECT_MISSING'],
      [sdkError(403, 'NotFound'), 'OBJECT_ACCESS_DENIED'],
      [sdkError(401), 'OBJECT_ACCESS_DENIED'],
      [sdkError(412), 'OBJECT_CHANGED'],
      [sdkError(500, 'NotFound'), 'OBJECT_READ_FAILED'],
      [new Error(secret), 'OBJECT_READ_FAILED'],
    ]) {
      const { report } = await audit({ a: plant('a'), b: plant('b') }, {
        storageOptions: { [stage]: (command) => { if (command.input.Key === keyFor('a')) throw error; } },
      });
      assert.equal(report.verified, 1);
      assert.equal(report.failedPhotoKeys, 1);
      assert.equal(report.errorsByCode[code], 1);
      assert.equal(report.scanComplete, true);
      assert.equal(reportExitCode(report), 1);
    }
  }
});

test('invalid sizes, content types, metadata and GET/HEAD disagreement are rejected and streams closed', async () => {
  const cases = [
    [{ head: { ContentLength: 0 } }, 'INVALID_OBJECT_SIZE'],
    [{ head: { ContentLength: -1 } }, 'INVALID_OBJECT_SIZE'],
    [{ head: { ContentLength: MAX_PHOTO_BYTES + 1 } }, 'INVALID_OBJECT_SIZE'],
    [{ head: { ContentLength: '100' } }, 'INVALID_OBJECT_SIZE'],
    [{ head: { ContentType: 'image/png' } }, 'INVALID_CONTENT_TYPE'],
    [{ head: { ETag: undefined } }, 'MISSING_ETAG'],
    [{ get: { ETag: 'changed' } }, 'OBJECT_CHANGED'],
    [{ get: { ContentLength: 1 } }, 'OBJECT_SIZE_MISMATCH'],
    [{ get: { ContentType: 'application/octet-stream' } }, 'INVALID_CONTENT_TYPE'],
    [{ get: { Body: undefined } }, 'OBJECT_READ_FAILED'],
    [{ head: { Metadata: { sha256: 'wrong' } } }, 'CHECKSUM_MISMATCH'],
    [{ get: { Metadata: { sha256: 'wrong' } } }, 'CHECKSUM_MISMATCH'],
    [{ makeBody: () => Readable.from([Buffer.alloc(1)]) }, 'OBJECT_SIZE_MISMATCH'],
    [{ makeBody: () => Readable.from([Buffer.alloc(MAX_PHOTO_BYTES + 1)]) }, 'OBJECT_SIZE_MISMATCH'],
    [{ makeBody: () => Readable.from((async function* () { yield Buffer.alloc(1); throw new Error(secret); })()) }, 'OBJECT_READ_FAILED'],
  ];
  for (const [storageOptions, code] of cases) {
    const { report, bodies } = await audit({ a: plant('a') }, { storageOptions });
    assert.equal(report.errorsByCode[code], 1, JSON.stringify(storageOptions));
    assert.equal(report.verified, 0);
    assert.ok(bodies.every((body) => body.destroyed));
  }
});

test('hung body is aborted within the object read deadline', async () => {
  const files = await storageFixture({ makeBody: () => new Readable({ read() {} }) });
  await assert.rejects(verifyObject({ ...files.connection, key: keyFor('a'), timeoutMs: 20 }),
    { code: 'OBJECT_READ_TIMEOUT' });
  assert.equal(files.bodies[0].destroyed, true);
});

test('fake, truncated, oversized and animated WebP fail; metadata alone is insufficient', async () => {
  const bytes = await webp;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const tooWide = await sharp({ create: { width: 1601, height: 1, channels: 3, background: 'red' } }).webp().toBuffer();
  const frames = Buffer.alloc(8 * 16 * 3, 127);
  frames.fill(255, 8 * 8 * 3);
  const animated = await sharp(frames, {
    raw: { width: 8, height: 16, channels: 3, pageHeight: 8 },
  }).webp({ loop: 0, delay: [100, 200] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  // Retain valid dimensions and an honest RIFF length while truncating the compressed pixels.
  const damaged = Buffer.from(bytes.subarray(0, bytes.length - 6));
  damaged.writeUInt32LE(damaged.length - 8, 4);
  assert.equal(bytes.toString('ascii', 12, 16), 'VP8 ');
  damaged.writeUInt32LE(damaged.length - 20, 16);
  assert.equal((await sharp(damaged).metadata()).format, 'webp');
  for (const invalid of [Buffer.from('RIFF0000WEBPinvalid'), png, tooWide, animated,
    bytes.subarray(0, 20), Buffer.concat([bytes, Buffer.from('junk')]), damaged]) {
    await assert.rejects(decodeWebP(invalid), { code: 'INVALID_WEBP' });
    const { report } = await audit({ a: plant('a') }, { storageOptions: { bytes: invalid } });
    assert.equal(report.errorsByCode.INVALID_WEBP, 1);
  }
});

test('obsolete photo fields are reported in active plants and trash, without skipping valid stored photos', async () => {
  const { report } = await audit({
    a: plant('a', { photo: legacy }),
    b: { userId: 'owner', photo: null, photoKey: null },
    c: { userId: 'owner', photo: legacy, deletedAt: '2026-11-19' },
    d: plant('d', { deletedAt: '2026-11-19' }),
    e: { userId: 'owner', photo: legacy },
    f: plant('f', { _photoDeleting: true, photo: 'https://example.invalid/photo' }),
    g: { userId: 'owner' },
  });
  assert.equal(report.photoKeyFields, 4);
  assert.equal(report.withPhotoKey, 3);
  assert.equal(report.withoutPhotoKey, 4);
  assert.equal(report.trashPlants, 2);
  assert.equal(report.legacyPhotoFields, 5);
  assert.equal(report.problemsByCode.LEGACY_PHOTO_FIELD, 5);
  assert.equal(report.problemsByCode.PHOTO_DELETION_IN_PROGRESS, 1);
  assert.equal(report.verified, 3);
  assert.equal(report.potentialProblems, 6);
  assert.equal(report.errors, 0);
  assert.equal(report.checksPassed, false);
  assert.equal(reportExitCode(report), 2);
});

test('optional expected key counts detect changes from a known baseline', async () => {
  const { report } = await audit({ a: plant('a') }, { options: { expectPhotoKeys: 2 } });
  assert.equal(report.potentialProblems, 1);
  assert.equal(report.problemsByCode.PHOTO_KEY_COUNT_MISMATCH, 1);
  assert.equal(reportExitCode(report), 2);
  const empty = await audit({}, { options: { expectPhotoKeys: 1 } });
  assert.equal(empty.report.problemsByCode.PHOTO_KEY_COUNT_MISMATCH, 1);
  assert.equal(reportExitCode(empty.report), 2);
});

test('empty collections and plants without photographs are valid without a migration target', async () => {
  for (const records of [{}, { a: { userId: 'owner' }, b: { userId: 'owner', photoKey: null } }]) {
    const { report, commands } = await audit(records, { options: { expectPhotoKeys: 0 } });
    assert.equal(report.scanComplete, true);
    assert.equal(report.checksPassed, true);
    assert.equal(report.potentialProblems, 0);
    assert.equal(reportExitCode(report), 0);
    assert.equal(commands.length, 0);
    const withoutExpectation = await audit(records);
    assert.equal(withoutExpectation.report.checksPassed, true);
    assert.equal(reportExitCode(withoutExpectation.report), 0);
  }
});

test('page read failure marks partial report incomplete, without exposing the raw SDK error', async () => {
  const records = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, { userId: 'owner' }]));
  const { report } = await audit(records, { firestoreOptions: { failPage: 2 } });
  assert.equal(report.totalDocuments, 100);
  assert.equal(report.scanComplete, false);
  assert.equal(report.errorsByCode.FIRESTORE_SCAN_FAILED, 1);
  assert.equal(report.checksPassed, false);
  assert.equal(reportExitCode(report), 1);
});

test('exactly 100 documents require a final empty page, and are counted once', async () => {
  const records = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { userId: 'owner' }]));
  const { report, queries } = await audit(records);
  assert.equal(report.totalDocuments, 100);
  assert.equal(queries.length, 2);
  assert.equal(report.scanComplete, true);
});

test('CLI help and configuration/argument errors do not initialize the cloud or expose input secrets', () => {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  for (const [args, expectedCode] of [[['--help'], 0], [['--project', project], 1], [['--project', secret], 1],
    [['--project', project, '--apply', secret], 1]]) {
    const result = spawnSync(process.execPath, ['scripts/verify-photos.cjs', ...args], {
      encoding: 'utf8', env, timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedCode, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.ok(!(result.stdout + result.stderr).includes('Error:'));
    if (args[0] === '--help') {
      assert.match(result.stdout, /photo integrity check/);
      assert.ok(!result.stdout.includes('--expect-trash-base64'));
    }
  }
});
