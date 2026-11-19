import { photoRequest, savePlantPhoto } from './plantPhotos';

const user = { uid: 'owner', getIdToken: jest.fn(async () => 'firebase-token') };
const reply = (body, ok = true) => ({ ok, json: async () => body });
const originalFetch = global.fetch;
beforeEach(() => { global.fetch = jest.fn(); user.getIdToken.mockResolvedValue('firebase-token'); });
afterAll(() => { global.fetch = originalFetch; });

test('sends Firebase token only to own API and WebP bytes to signed upload URL', async () => {
  const blob = new Blob(['webp'], { type: 'image/webp' });
  fetch.mockResolvedValueOnce(reply({ uploadId: 'ticket', url: 'https://storage.invalid/upload' }))
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce(reply({ photoKey: 'plants/owner/plant/photos/image.webp' }));
  await savePlantPhoto(user, { plantId: 'plant', blob, fields: { name: 'Ficus' }, creating: true });
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer firebase-token');
  expect(fetch.mock.calls[1]).toEqual(['https://storage.invalid/upload', {
    method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob, credentials: 'omit',
  }]);
  const body = JSON.parse(fetch.mock.calls[2][1].body);
  expect(body).toMatchObject({ action: 'commit', plantId: 'plant', uploadId: 'ticket' });
  expect(body).not.toHaveProperty('photo');
});

test('retry after lost commit response reuses upload ticket and never reuploads saved object', async () => {
  const blob = new Blob(['webp'], { type: 'image/webp' });
  const options = { plantId: 'plant', blob, fields: { name: 'Ficus' } };
  fetch.mockResolvedValueOnce(reply({ uploadId: 'ticket', url: 'https://storage.invalid/upload' }))
    .mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce(reply({ photoKey: 'saved-key' }));
  await expect(savePlantPhoto(user, options)).rejects.toThrow('lost response');
  await expect(savePlantPhoto(user, options)).resolves.toEqual({ photoKey: 'saved-key' });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(JSON.parse(fetch.mock.calls[3][1].body).uploadId).toBe('ticket');
});

test('upload failure never commits and retry requests a fresh upload URL', async () => {
  const blob = new Blob(['webp'], { type: 'image/webp' });
  const options = { plantId: 'plant', blob, fields: { name: 'Ficus' } };
  fetch.mockResolvedValueOnce(reply({ uploadId: 'ticket', url: 'https://storage.invalid/upload' }))
    .mockResolvedValueOnce({ ok: false });
  await expect(savePlantPhoto(user, options)).rejects.toThrow('Не удалось загрузить фото');
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce(reply({ uploadId: 'ticket2', url: 'https://storage.invalid/upload2' }))
    .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(reply({ photoKey: 'key' }));
  await savePlantPhoto(user, options);
  expect(JSON.parse(fetch.mock.calls[2][1].body).action).toBe('upload');
});

test('refuses base64/non-WebP and surfaces safe API errors', async () => {
  await expect(savePlantPhoto(user, { blob: 'data:image/png;base64,AA==' })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(reply({ error: 'Нет доступа к растению.' }, false));
  await expect(photoRequest(user, { action: 'read', plantId: 'other' })).rejects.toMatchObject({ photoError: true, message: 'Нет доступа к растению.' });
});
