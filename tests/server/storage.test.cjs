const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { S3Client } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const storage = require('../../server/storage.cjs');

test('photo keys are restricted to the exact owner, plant and published photo directory', () => {
  for (const filename of [
    '12345678-1234-1234-1234-123456789abc.webp',
    // Historical migration output for bytes "photo"; its UUID-shaped hash has no RFC variant bits.
    'b3d652ac-7074-4921-6e0d-7c6722eeac98.webp',
  ]) {
    const key = `${storage.plantPrefix('owner', 'plant-1')}photos/${filename}`;
    assert.ok(storage.ownsPhotoKey('owner', 'plant-1', key));
    assert.equal(storage.ownsPhotoKey('other', 'plant-1', key), false);
    assert.equal(storage.ownsPhotoKey('owner', 'plant-2', key), false);
    assert.equal(storage.ownsPhotoKey('owner', 'plant-1', key.replace('photos/', 'uploads/')), false);
    assert.equal(storage.ownsPhotoKey('owner', 'plant-1', `${key}/../../other`), false);
  }
});

test('permanent deletion removes migrated photos, replacements and staging across pages within the plant prefix', async (t) => {
  const vars = {
    YANDEX_BUCKET_NAME: 'test-photos', YANDEX_S3_ENDPOINT: 'https://storage.yandexcloud.net',
    YANDEX_ACCESS_KEY_ID: 'fake-test-access', YANDEX_SECRET_ACCESS_KEY: 'fake-test-secret',
  };
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const prefix = storage.plantPrefix('owner', 'plant-1');
  const keys = [
    `${prefix}photos/b3d652ac-7074-4921-6e0d-7c6722eeac98.webp`,
    `${prefix}photos/12345678-1234-4234-8234-123456789abc.webp`,
    `${prefix}uploads/12345678-1234-4234-8234-123456789abc.webp`,
  ];
  const deleted = [];
  const listed = [];
  const send = mock.method(S3Client.prototype, 'send', async (command) => {
    assert.equal(command.input.Bucket, vars.YANDEX_BUCKET_NAME);
    if (command.constructor.name === 'ListObjectsV2Command') {
      assert.equal(command.input.Prefix, prefix);
      listed.push(command.input.ContinuationToken);
      return command.input.ContinuationToken === undefined
        ? { Contents: keys.slice(0, 2).map((Key) => ({ Key })), IsTruncated: true, NextContinuationToken: 'page-2' }
        : { Contents: [{ Key: keys[2] }], IsTruncated: false };
    }
    assert.equal(command.constructor.name, 'DeleteObjectCommand');
    deleted.push(command.input.Key);
    return {};
  });
  t.after(() => send.mock.restore());
  await storage.deletePlantFiles('owner', 'plant-1');
  assert.deepEqual(listed, [undefined, 'page-2']);
  assert.deepEqual(deleted, keys);

  for (const foreignPrefix of [storage.plantPrefix('other', 'plant-1'), storage.plantPrefix('owner', 'plant-2')]) {
    send.mock.mockImplementation(async (command) => {
      assert.equal(command.constructor.name, 'ListObjectsV2Command');
      return { Contents: [{ Key: `${foreignPrefix}photos/b3d652ac-7074-4921-6e0d-7c6722eeac98.webp` }] };
    });
    await assert.rejects(storage.deletePlantFiles('owner', 'plant-1'), /Invalid deletion scope/);
  }
});

test('migration keys are deterministic, content-specific and compatible with existing ownership checks', () => {
  const bytes = Buffer.from('photo');
  const key = storage.migrationPhotoKey('owner', 'plant-1', bytes);
  assert.equal(key, storage.migrationPhotoKey('owner', 'plant-1', Buffer.from('photo')));
  assert.ok(storage.ownsPhotoKey('owner', 'plant-1', key));
  assert.notEqual(key, storage.migrationPhotoKey('owner', 'plant-1', Buffer.from('other photo')));
  assert.notEqual(key, storage.migrationPhotoKey('other', 'plant-1', bytes));
  assert.notEqual(key, storage.migrationPhotoKey('owner', 'plant-2', bytes));
});

test('migration storage never overwrites mismatched objects or treats failed HEAD as absence', async () => {
  const sha256 = createHash('sha256').update('photo').digest('hex');
  for (const head of [
    { ContentLength: 5, ContentType: 'image/webp', Metadata: { sha256: 'wrong' } },
    { ContentLength: 5, ContentType: 'image/webp' },
    { ContentLength: 10, ContentType: 'image/webp', Metadata: { sha256 } },
    { ContentLength: 5, ContentType: 'image/png', Metadata: { sha256 } },
    new Error('network failure'),
    Object.assign(new Error('forbidden'), { $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error('forbidden'), { name: 'NotFound', $metadata: { httpStatusCode: 403 } }),
  ]) {
    const commands = [];
    const client = { send: async (command) => {
      commands.push(command);
      if (head instanceof Error) throw head;
      return head;
    } };
    await assert.rejects(storage.storeMigrationPhoto('owner', 'plant-1', Buffer.from('photo'), { client, bucket: 'fake' }));
    assert.deepEqual(commands.map((command) => command.constructor.name), ['HeadObjectCommand']);
  }
});

test('server decodes real WebP and rejects spoofed, oversized and broken images', async () => {
  const image = (width, height) => sharp({ create: { width, height, channels: 3, background: '#297c41' } });
  const webp = await image(1600, 1000).webp().toBuffer();
  const result = await storage.normalizeUpload(webp);
  assert.equal((await sharp(result).metadata()).format, 'webp');
  await assert.rejects(storage.normalizeUpload(await image(1601, 1000).webp().toBuffer()), { status: 400 });
  await assert.rejects(storage.normalizeUpload(await image(200, 100).png().toBuffer()), { status: 400 });
  await assert.rejects(storage.normalizeUpload(Buffer.from('RIFFinvalidWEBP')), { status: 400 });
});

test('new photos store main and thumbnail WebP versions in the same private bucket', async () => {
  const source = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#297c41' } }).webp().toBuffer();
  const main = await storage.normalizeUpload(source);
  const commands = [];
  const connection = { bucket: 'same-bucket', client: { send: async (command) => { commands.push(command); } } };
  const keys = await storage.storePhotoVersions('owner', 'plant-1', main, connection);
  assert.notEqual(keys.photoKey, keys.photoThumbKey);
  assert.deepEqual(commands.map((command) => command.constructor.name), ['PutObjectCommand', 'PutObjectCommand']);
  for (const [index, command] of commands.entries()) {
    assert.equal(command.input.Bucket, 'same-bucket');
    assert.equal(command.input.Key, index === 0 ? keys.photoKey : keys.photoThumbKey);
    assert.ok(storage.ownsPhotoKey('owner', 'plant-1', command.input.Key));
    assert.equal(command.input.ContentType, 'image/webp');
    assert.equal(command.input.CacheControl, 'private, max-age=300');
    assert.equal(command.input.ACL, undefined);
    const metadata = await sharp(command.input.Body).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, index === 0 ? 1600 : 300);
    assert.equal(metadata.height, index === 0 ? 1000 : 188);
  }
});

test('thumbnail preserves portrait proportions and never enlarges small files', async () => {
  for (const [width, height, expected] of [[800, 1600, [150, 300]], [80, 60, [80, 60]]]) {
    const source = await sharp({ create: { width, height, channels: 3, background: '#297c41' } }).webp().toBuffer();
    const metadata = await sharp(await storage.createPhotoThumbnail(source)).metadata();
    assert.deepEqual([metadata.width, metadata.height], expected);
  }
});

test('processing failure writes nothing and a failed PUT rolls back both new keys, including a lost response', async () => {
  const source = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#297c41' } }).webp().toBuffer();
  for (const failAt of [1, 2]) {
    const objects = new Map();
    let puts = 0;
    const connection = { bucket: 'same-bucket', client: { send: async (command) => {
      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(command.input.Key, command.input.Body);
        if (++puts === failAt) throw new Error('PUT response lost');
      } else if (command.constructor.name === 'DeleteObjectCommand') objects.delete(command.input.Key);
      else assert.fail('Unexpected command');
    } } };
    await assert.rejects(storage.storePhotoVersions('owner', 'plant-1', source, connection), /PUT response lost/);
    assert.equal(objects.size, 0);
    puts = 0;
    await assert.rejects(storage.storePhotoVersions('owner', 'plant-1', Buffer.from('invalid'), connection));
    assert.equal(puts, 0);
  }
});

test('permanent deletion removes original, thumbnail, staging and old versions only under the plant prefix', async () => {
  const prefix = storage.plantPrefix('owner', 'plant-1');
  const keys = [`${prefix}photos/main.webp`, `${prefix}photos/thumb.webp`, `${prefix}uploads/staging.webp`, `${prefix}photos/old.webp`];
  const deleted = [];
  const connection = { bucket: 'same-bucket', client: { send: async (command) => {
    if (command.constructor.name === 'ListObjectsV2Command') {
      assert.equal(command.input.Prefix, prefix);
      return { Contents: keys.map((Key) => ({ Key })) };
    }
    assert.equal(command.constructor.name, 'DeleteObjectCommand');
    deleted.push(command.input.Key);
  } } };
  await storage.deletePlantFiles('owner', 'plant-1', connection);
  assert.deepEqual(deleted, keys);
  await assert.rejects(storage.deletePhotoVersions('owner', 'plant-1', {
    photoKey: 'foreign/key', photoThumbKey: 'foreign/thumb',
  }, connection), /Invalid deletion scope/);
});

test('presigned URLs bind content type/length and have bounded expiry without cloud calls', async () => {
  const vars = {
    YANDEX_BUCKET_NAME: 'test-photos', YANDEX_S3_ENDPOINT: 'https://storage.yandexcloud.net',
    YANDEX_ACCESS_KEY_ID: 'fake-test-access', YANDEX_SECRET_ACCESS_KEY: 'fake-test-secret',
  };
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    const url = new URL(await storage.signUpload('plants/test/uploads/upload.webp', 100));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    const headers = url.searchParams.get('X-Amz-SignedHeaders').split(';');
    assert.ok(headers.includes('content-type'));
    assert.ok(headers.includes('content-length'));
    assert.equal(url.href.includes('fake-test-secret'), false);
    const read = new URL(await storage.readUrl('plants/test/photos/photo.webp'));
    assert.equal(read.searchParams.get('X-Amz-Expires'), '600');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
