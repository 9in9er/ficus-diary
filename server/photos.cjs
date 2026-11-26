const { randomUUID } = require('node:crypto');
const { getFirebase } = require('./firebase.cjs');
const storage = require('./storage.cjs');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

function owned(snapshot, uid, { writable = false } = {}) {
  if (!snapshot.exists) fail(404, 'Растение не найдено.');
  const plant = snapshot.data();
  if (plant.userId !== uid) fail(403, 'Нет доступа к растению.');
  if (plant._photoDeleting || (writable && plant.deletedAt)) fail(409, 'Растение в корзине или удаляется.');
  return plant;
}

function plantFields(input, isWishlisted) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) {
    fail(400, 'Введите название растения (до 200 символов).');
  }
  const fields = { name: input.name.trim() };
  if (isWishlisted) {
    if (typeof input.description !== 'string' || input.description.length > 10000
      || typeof input.price !== 'string' || input.price.length > 200
      || !Array.isArray(input.links) || input.links.length > 30) fail(400, 'Некорректные данные вишлиста.');
    for (const link of input.links) {
      try {
        if (typeof link !== 'string' || link.length > 2000 || !['https:', 'http:'].includes(new URL(link).protocol)) throw new Error();
      } catch { fail(400, 'Некорректная ссылка.'); }
    }
    Object.assign(fields, { description: input.description, price: input.price, links: input.links });
  } else {
    if (typeof input.acquiredAt !== 'string' || (input.acquiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.acquiredAt))) {
      fail(400, 'Некорректная дата появления растения.');
    }
    fields.acquiredAt = input.acquiredAt;
    if (Object.hasOwn(input, 'price')) {
      if (input.price !== null && (!Number.isFinite(input.price) || input.price < 0 || input.price > 1e12)) fail(400, 'Некорректная цена покупки.');
      fields.price = input.price;
    }
    if (Object.hasOwn(input, 'soldAt') || Object.hasOwn(input, 'salePrice')) {
      if (typeof input.soldAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.soldAt)
        || input.soldAt.startsWith('0000') || Number.isNaN(Date.parse(input.soldAt))
        || new Date(input.soldAt).toISOString().slice(0, 10) !== input.soldAt
        || !Number.isFinite(input.salePrice) || input.salePrice < 0 || input.salePrice > 1e12) fail(400, 'Некорректные данные продажи.');
      Object.assign(fields, { soldAt: input.soldAt, salePrice: input.salePrice });
    }
  }
  return fields;
}

function createPhotoService({ db, files = storage, now = () => Date.now(), deletionEnabled = false }) {
  return async (uid, body) => {
    const { action, plantId } = body;
    if (!validId(plantId)) fail(400, 'Некорректный ID растения.');
    const ref = db.collection('plants').doc(plantId);

    if (action === 'link') {
      let photo;
      try {
        if (typeof body.photo !== 'string' || !/^https?:\/\//i.test(body.photo.trim())) throw new Error();
        photo = body.photo.trim();
        const url = new URL(photo);
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw new Error();
      } catch { fail(400, 'Введите корректную ссылку на изображение с http:// или https://.'); }
      // Store only the URL. No request to the external host or object storage.
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const creating = body.creating === true;
        if (creating && snapshot.exists) fail(409, 'Растение уже существует.');
        const plant = creating ? null : owned(snapshot, uid, { writable: true });
        const isWishlisted = creating ? body.isWishlisted === true : !!plant.isWishlisted;
        const fields = plantFields(body.fields, isWishlisted);
        if (creating) {
          tx.create(ref, { ...fields, photo, userId: uid, isWishlisted,
            createdAt: new Date(now()).toISOString(), deletedAt: null, hidden: false, pinned: false,
            ...(!isWishlisted ? { wateringLog: [], fertilizingLog: [], notes: [] } : {}),
          });
        } else {
          // Old objects remain available for the existing permanent-delete flow.
          tx.update(ref, { ...fields, photo, photoKey: null, photoThumbKey: null });
        }
        return { photo };
      });
    }

    if (action === 'read') {
      const variant = body.variant === undefined ? 'original' : body.variant;
      if (!['original', 'thumbnail'].includes(variant)) fail(400, 'Некорректный вариант фотографии.');
      const plant = owned(await ref.get(), uid);
      if (!plant.photoKey) return { url: null };
      const key = variant === 'thumbnail' ? plant.photoThumbKey || plant.photoKey : plant.photoKey;
      if (!files.ownsPhotoKey(uid, plantId, key)) fail(409, 'Некорректный ключ фотографии.');
      return { url: await files.readUrl(key), expiresIn: files.READ_SECONDS };
    }

    if (action === 'upload') {
      if (!Number.isInteger(body.size) || body.size < 1 || body.size > files.MAX_PHOTO_BYTES) fail(400, 'Фото должно быть не больше 5 МБ.');
      const snapshot = await ref.get();
      const creating = body.creating === true;
      if (creating && snapshot.exists) fail(409, 'Растение уже существует.');
      const plant = creating ? null : owned(snapshot, uid, { writable: true });
      const uploadId = randomUUID();
      const key = `${files.plantPrefix(uid, plantId)}uploads/${uploadId}.webp`;
      const url = await files.signUpload(key, body.size);
      await db.collection('_photoUploads').doc(uploadId).set({
        uid, plantId, key, size: body.size, creating,
        previousKey: plant?.photoKey || null,
        previousThumbKey: plant?.photoThumbKey || null,
        expiresAt: now() + 15 * 60 * 1000,
      });
      return { uploadId, url, expiresIn: files.UPLOAD_SECONDS };
    }

    if (action === 'commit') {
      if (!validId(body.uploadId)) fail(400, 'Некорректный ID загрузки.');
      const ticketRef = db.collection('_photoUploads').doc(body.uploadId);
      const snapshot = await ticketRef.get();
      const ticket = snapshot.data();
      if (!snapshot.exists || ticket.uid !== uid || ticket.plantId !== plantId) fail(403, 'Нет доступа к загрузке.');
      // A lost HTTP response can be retried without creating another plant or file.
      if (ticket.committedKey) {
        const plant = owned(await ref.get(), uid);
        if (plant.photoKey !== ticket.committedKey
          || (ticket.committedThumbKey && plant.photoThumbKey !== ticket.committedThumbKey)) fail(409, 'Фотография уже изменена.');
        return { photoKey: ticket.committedKey, ...(ticket.committedThumbKey ? { photoThumbKey: ticket.committedThumbKey } : {}) };
      }
      if (ticket.expiresAt < now()) fail(410, 'Срок загрузки истёк. Выберите фото ещё раз.');
      const current = await ref.get();
      if (ticket.creating ? current.exists : !current.exists) fail(409, 'Растение изменилось. Обновите страницу.');
      const plant = ticket.creating ? null : owned(current, uid, { writable: true });
      if ((plant?.photoKey || null) !== ticket.previousKey
        || (plant?.photoThumbKey || null) !== (ticket.previousThumbKey || null)) fail(409, 'Фото уже изменено в другой вкладке.');
      const isWishlisted = ticket.creating ? body.isWishlisted === true : !!plant.isWishlisted;
      const fields = plantFields(body.fields, isWishlisted);
      const bytes = await files.validateUpload(ticket.key, ticket.size);
      const keys = await files.storePhotoVersions(uid, plantId, bytes);
      // Do not delete on an ambiguous transaction error: the write may have committed.
      // Unreferenced uploads and old versions are removed only on permanent deletion.
      let result;
      try {
        result = await db.runTransaction(async (tx) => {
          const [fresh, freshTicket] = await Promise.all([tx.get(ref), tx.get(ticketRef)]);
          const latest = freshTicket.data();
          if (!freshTicket.exists || latest.uid !== uid || latest.plantId !== plantId) fail(403, 'Нет доступа к загрузке.');
          if (latest.committedKey) {
            const latestPlant = owned(fresh, uid);
            if (latestPlant.photoKey !== latest.committedKey
              || (latest.committedThumbKey && latestPlant.photoThumbKey !== latest.committedThumbKey)) fail(409, 'Фото уже изменено.');
            return { photoKey: latest.committedKey, ...(latest.committedThumbKey ? { photoThumbKey: latest.committedThumbKey } : {}) };
          }
          if (latest.expiresAt < now()) fail(410, 'Срок загрузки истёк.');
          if (ticket.creating) {
            if (fresh.exists) fail(409, 'Растение уже существует.');
            tx.create(ref, { ...fields, ...keys, userId: uid, isWishlisted,
              createdAt: new Date(now()).toISOString(), deletedAt: null, hidden: false, pinned: false,
              ...(!isWishlisted ? { wateringLog: [], fertilizingLog: [], notes: [] } : {}),
            });
          } else {
            const latestPlant = owned(fresh, uid, { writable: true });
            if ((latestPlant.photoKey || null) !== ticket.previousKey
              || (latestPlant.photoThumbKey || null) !== (ticket.previousThumbKey || null)
              || !!latestPlant.isWishlisted !== isWishlisted) {
              fail(409, 'Растение изменилось. Обновите страницу.');
            }
            tx.update(ref, { ...fields, ...keys }); // Preserve legacy photo, including base64.
          }
          tx.update(ticketRef, { committedKey: keys.photoKey, committedThumbKey: keys.photoThumbKey });
          return keys;
        });
      } catch (error) {
        // Explicit validation conflicts happen before writes. Never remove a pair
        // on an ambiguous SDK failure: the atomic transaction may have committed.
        if (error.status) await files.deletePhotoVersions(uid, plantId, keys);
        throw error;
      }
      // Another concurrent commit may have won using the same upload ticket.
      if (result.photoKey !== keys.photoKey) await files.deletePhotoVersions(uid, plantId, keys);
      return result;
    }

    if (action === 'delete') {
      if (!deletionEnabled) fail(409, 'Окончательное удаление пока отключено. Растение останется в корзине.');
      // Lock first so a restore or photo commit cannot race with file deletion.
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return;
        const plant = snapshot.data();
        if (plant.userId !== uid) fail(403, 'Нет доступа к растению.');
        if (!plant.deletedAt) fail(409, 'Сначала переместите растение в корзину.');
        if (plant.photoKey && !files.ownsPhotoKey(uid, plantId, plant.photoKey)) fail(409, 'Некорректный ключ фотографии.');
        if (plant.photoThumbKey && !files.ownsPhotoKey(uid, plantId, plant.photoThumbKey)) fail(409, 'Некорректный ключ миниатюры.');
        tx.update(ref, { _photoDeleting: true });
      });
      await files.deletePlantFiles(uid, plantId);
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return;
        const plant = snapshot.data();
        if (plant.userId !== uid || !plant.deletedAt || !plant._photoDeleting) fail(409, 'Растение изменилось.');
        tx.delete(ref);
      });
      return { deleted: true };
    }
    fail(400, 'Неизвестная операция.');
  };
}

function createHandler({ getServices = getFirebase, files = storage } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Метод не поддерживается.' });
    }
    try {
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) fail(401, 'Войдите в аккаунт.');
      const { auth, db } = getServices();
      let token;
      try { token = await auth.verifyIdToken(authorization.slice(7), true); }
      catch { fail(401, 'Сессия истекла. Войдите в аккаунт ещё раз.'); }
      let body = req.body;
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > 32768) fail(413, 'Слишком большой запрос.');
        try { body = JSON.parse(body); } catch { fail(400, 'Некорректный JSON.'); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Некорректный запрос.');
      if (Buffer.byteLength(JSON.stringify(body)) > 32768) fail(413, 'Слишком большой запрос.');
      const service = createPhotoService({ db, files,
        deletionEnabled: process.env.ENABLE_PERMANENT_PLANT_DELETE === 'true' });
      return res.status(200).json(await service(token.uid, body));
    } catch (error) {
      // Never log credentials, tokens, signed URLs, request bodies or legacy photos.
      if (!error.status) console.error('Photo API operation failed', { code: error.code || error.name });
      return res.status(error.status || 503).json({ error: error.status ? error.message : 'Не удалось подключиться к хранилищу. Попробуйте ещё раз.' });
    }
  };
}

module.exports = { createHandler, createPhotoService, plantFields, owned, validId };
