const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const storage = require('../../server/storage.cjs');

test('photo keys are restricted to the exact owner, plant and published photo directory', () => {
  const key = `${storage.plantPrefix('owner', 'plant-1')}photos/12345678-1234-1234-1234-123456789abc.webp`;
  assert.ok(storage.ownsPhotoKey('owner', 'plant-1', key));
  assert.equal(storage.ownsPhotoKey('other', 'plant-1', key), false);
  assert.equal(storage.ownsPhotoKey('owner', 'plant-2', key), false);
  assert.equal(storage.ownsPhotoKey('owner', 'plant-1', key.replace('photos/', 'uploads/')), false);
  assert.equal(storage.ownsPhotoKey('owner', 'plant-1', `${key}/../../other`), false);
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
