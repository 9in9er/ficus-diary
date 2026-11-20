const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
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

test('server decodes real WebP and rejects spoofed, oversized and broken images', async () => {
  const image = (width, height) => sharp({ create: { width, height, channels: 3, background: '#297c41' } });
  const webp = await image(1600, 1000).webp().toBuffer();
  const result = await storage.normalizeUpload(webp);
  assert.equal((await sharp(result).metadata()).format, 'webp');
  await assert.rejects(storage.normalizeUpload(await image(1601, 1000).webp().toBuffer()), { status: 400 });
  await assert.rejects(storage.normalizeUpload(await image(200, 100).png().toBuffer()), { status: 400 });
  await assert.rejects(storage.normalizeUpload(Buffer.from('RIFFinvalidWEBP')), { status: 400 });
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
