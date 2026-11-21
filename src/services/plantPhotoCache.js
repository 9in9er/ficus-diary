import { photoRequest } from './plantPhotos';

const links = new Map();
const cacheKey = (uid, photoKey, variant) => JSON.stringify([uid, photoKey, variant]);

export function clearPlantPhotoCache() {
  links.clear();
}

export function invalidatePlantPhotoUrl(uid, photoKey, url, variant = 'original') {
  const key = cacheKey(uid, photoKey, variant);
  // A late image error must not evict a newer link or an ongoing retry.
  if (url && links.get(key)?.url === url) links.delete(key);
}

export function getPlantPhotoUrl(user, plantId, photoKey, variant = 'original') {
  const key = cacheKey(user.uid, photoKey, variant);
  const cached = links.get(key);
  if (cached?.promise) return cached.promise;
  if (cached?.expiresAt > Date.now()) return Promise.resolve(cached.url);

  const entry = {};
  const startedAt = Date.now();
  entry.promise = photoRequest(user, { action: 'read', plantId, ...(variant === 'original' ? {} : { variant }) }).then((result) => {
    if (!result.url) throw new Error('Photo URL is unavailable');
    // Allow for request time and clock/transport delays before a new image load.
    if (links.get(key) === entry) {
      entry.url = result.url;
      entry.expiresAt = startedAt + Math.max(0, (result.expiresIn || 600) - 30) * 1000;
      delete entry.promise;
    }
    return result.url;
  }).catch((error) => {
    if (links.get(key) === entry) links.delete(key);
    throw error;
  });
  links.set(key, entry);
  return entry.promise;
}
