import { photoRequest } from './plantPhotos';
import { clearPlantPhotoCache, getPlantPhotoUrl, invalidatePlantPhotoUrl } from './plantPhotoCache';

jest.mock('./plantPhotos', () => ({ photoRequest: jest.fn() }));
const user = { uid: 'owner' };

beforeEach(() => {
  jest.clearAllMocks();
  clearPlantPhotoCache();
});
afterEach(() => jest.useRealTimers());

test('shares an in-flight request and reuses the resolved link', async () => {
  let finish;
  photoRequest.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = getPlantPhotoUrl(user, 'plant', 'key');
  expect(getPlantPhotoUrl(user, 'plant', 'key')).toBe(first);
  expect(photoRequest).toHaveBeenCalledTimes(1);
  finish({ url: 'signed', expiresIn: 600 });
  await expect(first).resolves.toBe('signed');
  await expect(getPlantPhotoUrl(user, 'plant', 'key')).resolves.toBe('signed');
  expect(photoRequest).toHaveBeenCalledTimes(1);
});

test('separates owners and photo versions', async () => {
  photoRequest.mockResolvedValue({ url: 'signed', expiresIn: 600 });
  await getPlantPhotoUrl(user, 'plant', 'key');
  await getPlantPhotoUrl({ uid: 'other' }, 'plant', 'key');
  await getPlantPhotoUrl(user, 'plant', 'replacement');
  expect(photoRequest).toHaveBeenCalledTimes(3);
});

test('isolates variants in the cache and deduplicates simultaneous thumbnail requests', async () => {
  photoRequest.mockResolvedValueOnce({ url: 'original', expiresIn: 600 })
    .mockResolvedValueOnce({ url: 'thumbnail', expiresIn: 600 });
  await expect(getPlantPhotoUrl(user, 'plant', 'same-key', 'original')).resolves.toBe('original');
  const thumbnail = getPlantPhotoUrl(user, 'plant', 'same-key', 'thumbnail');
  expect(getPlantPhotoUrl(user, 'plant', 'same-key', 'thumbnail')).toBe(thumbnail);
  await expect(thumbnail).resolves.toBe('thumbnail');
  expect(photoRequest).toHaveBeenLastCalledWith(user, { action: 'read', plantId: 'plant', variant: 'thumbnail' });
  invalidatePlantPhotoUrl(user.uid, 'same-key', 'thumbnail', 'thumbnail');
  await expect(getPlantPhotoUrl(user, 'plant', 'same-key', 'original')).resolves.toBe('original');
  expect(photoRequest).toHaveBeenCalledTimes(2);
});

test('requests a fresh URL before an expired link can be reused', async () => {
  jest.useFakeTimers();
  photoRequest.mockResolvedValueOnce({ url: 'old', expiresIn: 600 })
    .mockResolvedValueOnce({ url: 'new', expiresIn: 600 });
  await getPlantPhotoUrl(user, 'plant', 'key');
  jest.advanceTimersByTime(600000);
  await expect(getPlantPhotoUrl(user, 'plant', 'key')).resolves.toBe('new');
  expect(photoRequest).toHaveBeenCalledTimes(2);
});

test('failed requests are not cached and an image error permits a deduplicated retry', async () => {
  photoRequest.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ url: 'broken', expiresIn: 600 })
    .mockResolvedValueOnce({ url: 'fixed', expiresIn: 600 });
  await expect(getPlantPhotoUrl(user, 'plant', 'key')).rejects.toThrow('offline');
  await getPlantPhotoUrl(user, 'plant', 'key');
  invalidatePlantPhotoUrl(user.uid, 'key', 'broken');
  const retry = getPlantPhotoUrl(user, 'plant', 'key');
  invalidatePlantPhotoUrl(user.uid, 'key', 'broken');
  expect(getPlantPhotoUrl(user, 'plant', 'key')).toBe(retry);
  await expect(retry).resolves.toBe('fixed');
  invalidatePlantPhotoUrl(user.uid, 'key', 'broken');
  await expect(getPlantPhotoUrl(user, 'plant', 'key')).resolves.toBe('fixed');
  expect(photoRequest).toHaveBeenCalledTimes(3);
});

test('clearing on logout discards cached links and late requests cannot repopulate them', async () => {
  let finish;
  photoRequest.mockResolvedValueOnce({ url: 'cached', expiresIn: 600 })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ url: 'fresh', expiresIn: 600 })
    .mockResolvedValueOnce({ url: 'fresh-cached', expiresIn: 600 });
  await getPlantPhotoUrl(user, 'plant', 'key');
  const pending = getPlantPhotoUrl(user, 'other-plant', 'other-key');
  clearPlantPhotoCache();
  finish({ url: 'late', expiresIn: 600 });
  await pending;
  await expect(getPlantPhotoUrl(user, 'other-plant', 'other-key')).resolves.toBe('fresh');
  await expect(getPlantPhotoUrl(user, 'plant', 'key')).resolves.toBe('fresh-cached');
  expect(photoRequest).toHaveBeenCalledTimes(4);
});
