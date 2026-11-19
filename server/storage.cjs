const { createHash, randomUUID } = require('node:crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const UPLOAD_SECONDS = 300;
const READ_SECONDS = 600;
let client;

function storage() {
  const bucket = process.env.YANDEX_BUCKET_NAME;
  const endpoint = process.env.YANDEX_S3_ENDPOINT;
  const accessKeyId = process.env.YANDEX_ACCESS_KEY_ID;
  const secretAccessKey = process.env.YANDEX_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) throw new Error('Object Storage is not configured');
  if (new URL(endpoint).protocol !== 'https:') throw new Error('Storage endpoint must use HTTPS');
  if (!client) client = new S3Client({
    endpoint, region: 'ru-central1', forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // Yandex implements S3; optional AWS checksum trailers are not required.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { client, bucket };
}

function plantPrefix(uid, plantId) {
  return `plants/${createHash('sha256').update(uid).digest('hex')}/${plantId}/`;
}

function ownsPhotoKey(uid, plantId, key) {
  const prefix = `${plantPrefix(uid, plantId)}photos/`;
  return typeof key === 'string' && key.startsWith(prefix)
    && /^[a-f0-9-]{36}\.webp$/.test(key.slice(prefix.length));
}

async function signUpload(key, size) {
  const { client: s3, bucket } = storage();
  return getSignedUrl(s3, new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: 'image/webp', ContentLength: size,
  }), { expiresIn: UPLOAD_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) });
}

async function readUrl(key) {
  const { client: s3, bucket } = storage();
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket, Key: key, ResponseCacheControl: 'private, max-age=300',
  }), { expiresIn: READ_SECONDS });
}

async function validateUpload(key, size) {
  const { client: s3, bucket } = storage();
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength !== size || size > MAX_PHOTO_BYTES || head.ContentType !== 'image/webp') {
    throw Object.assign(new Error('Invalid uploaded image'), { status: 400 });
  }
  // IfMatch prevents a replayed PUT from changing bytes between HEAD and GET.
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag }));
  const chunks = [];
  let total = 0;
  for await (const chunk of object.Body) {
    total += chunk.length;
    if (total > MAX_PHOTO_BYTES) {
      object.Body.destroy();
      throw Object.assign(new Error('Image too large'), { status: 400 });
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== size) throw Object.assign(new Error('Invalid image size'), { status: 400 });
  return normalizeUpload(bytes);
}

async function normalizeUpload(bytes) {
  try {
    const image = sharp(bytes, { limitInputPixels: 1600 * 1600, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== 'webp' || !metadata.width || !metadata.height
      || Math.max(metadata.width, metadata.height) > 1600 || (metadata.pages || 1) !== 1) throw new Error('Invalid image');
    // Decode fully and normalize before publishing; browser PUT URLs only access staging.
    return await image.rotate().webp({ quality: 80 }).toBuffer();
  } catch {
    throw Object.assign(new Error('Invalid WebP image'), { status: 400 });
  }
}

async function storePhoto(uid, plantId, bytes) {
  const { client: s3, bucket } = storage();
  const key = `${plantPrefix(uid, plantId)}photos/${randomUUID()}.webp`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes,
    ContentType: 'image/webp', CacheControl: 'private, max-age=300' }));
  return key;
}

async function deletePlantFiles(uid, plantId) {
  const { client: s3, bucket } = storage();
  const prefix = plantPrefix(uid, plantId);
  let continuation;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuation }));
    for (const object of page.Contents || []) {
      if (!object.Key.startsWith(prefix)) throw new Error('Invalid deletion scope');
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
    }
    continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuation);
}

module.exports = { MAX_PHOTO_BYTES, UPLOAD_SECONDS, READ_SECONDS, plantPrefix, ownsPhotoKey,
  signUpload, readUrl, validateUpload, normalizeUpload, storePhoto, deletePlantFiles };
