export async function photoRequest(user, body) {
  if (!user?.getIdToken) throw new Error('Войдите в аккаунт ещё раз.');
  const token = await user.getIdToken();
  const response = await fetch('/api/photos', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), cache: 'no-store',
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('Сервер фотографий недоступен. Попробуйте ещё раз.'); }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Не удалось сохранить фотографию.'), { photoError: true, status: response.status });
  return result;
}

// Reuse tickets after lost commit responses. Credentials/URLs are never persisted.
const pending = new WeakMap();
export async function savePlantPhoto(user, { plantId, blob, fields, creating = false, isWishlisted = false }) {
  if (!(blob instanceof Blob) || blob.type !== 'image/webp' || blob.size > 5 * 1024 * 1024 || !blob.size) {
    throw new Error('Выберите фотографию ещё раз.');
  }
  let sessions = pending.get(blob);
  if (!sessions) { sessions = new Map(); pending.set(blob, sessions); }
  const sessionId = `${user.uid}:${plantId}`;
  let ticket = sessions.get(sessionId);
  if (ticket && !ticket.uploaded && ticket.expiresAt < Date.now()) ticket = null;
  if (!ticket) {
    ticket = await photoRequest(user, { action: 'upload', plantId, creating, size: blob.size });
    ticket.expiresAt = Date.now() + (ticket.expiresIn || 300) * 1000;
    sessions.set(sessionId, ticket);
  }
  if (!ticket.uploaded) {
    const response = await fetch(ticket.url, {
      method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob, credentials: 'omit',
    });
    if (!response.ok) {
      sessions.delete(sessionId);
      throw new Error('Не удалось загрузить фото. Проверьте подключение и попробуйте ещё раз.');
    }
    ticket.uploaded = true;
  }
  try {
    return await photoRequest(user, { action: 'commit', plantId, uploadId: ticket.uploadId, fields, isWishlisted });
  } catch (error) {
    if (error.status === 410) sessions.delete(sessionId);
    throw error;
  }
}
