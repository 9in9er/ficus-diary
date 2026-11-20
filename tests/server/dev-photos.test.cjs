const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const photos = require('../../server/photos.cjs');
const setupProxy = require('../../src/setupProxy');

test('CRA serves the photo API with the production handler and bounded JSON requests', async (t) => {
  const createHandler = photos.createHandler;
  t.mock.method(photos, 'createHandler', () => createHandler({
    getServices: () => ({
      auth: { verifyIdToken: async (token, revoked) => {
        assert.equal(token, 'local-test-token');
        assert.equal(revoked, true);
        return { uid: 'owner' };
      } },
      db: { collection: () => ({ doc: () => ({ get: async () => ({
        exists: true, data: () => ({ userId: 'owner' }),
      }) }) }) },
    }),
  }));
  const app = express();
  setupProxy(app);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/photos`;
  const post = (body, authenticated = true) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: 'Bearer local-test-token' } : {}) },
    body,
  });

  await t.test('GET reaches the API instead of returning a CRA 404', async () => {
    const response = await fetch(url);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.equal(typeof (await response.json()).error, 'string');
  });
  await t.test('POST still requires authentication', async () => {
    const response = await post('{}', false);
    assert.equal(response.status, 401);
    assert.equal(typeof (await response.json()).error, 'string');
  });
  await t.test('authenticated JSON reaches the photo service', async () => {
    const response = await post(JSON.stringify({ action: 'read', plantId: 'plant-1' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { url: null });
  });
  await t.test('malformed JSON is rejected by the handler', async () => {
    const response = await post('{broken');
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  });
  await t.test('oversized JSON returns a JSON error', async () => {
    const response = await post(JSON.stringify({ text: 'x'.repeat(32768) }));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { error: 'Слишком большой запрос.' });
  });
});
