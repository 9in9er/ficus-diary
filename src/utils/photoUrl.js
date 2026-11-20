export function isHttpPhotoUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname;
  } catch {
    return false;
  }
}

export function getDraftPhotoUrl(draft) {
  if (draft.photoSource !== 'url') return null;
  if (!isHttpPhotoUrl(draft.photoUrl)) {
    throw Object.assign(new Error('Введите корректную ссылку на изображение с http:// или https://.'), { photoError: true });
  }
  return draft.photoUrl.trim();
}
