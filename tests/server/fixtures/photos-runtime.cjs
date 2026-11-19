const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createPublicKey, generateKeyPairSync, sign } = require('node:crypto');
const path = require('node:path');

assert.equal(process.versions.node.split('.')[0], '24');
assert.equal(process.features.require_module, false);
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, undefined);

// Load the deployed entry point before installing any mocks. The unpatched
// jwks-rsa fails here with ERR_REQUIRE_ESM, even for unauthenticated requests.
const handler = require('../../../api/photos.js');
const { getFirebase } = require('../../../server/firebase.cjs');
const { getApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const adminRoot = path.resolve(path.dirname(require.resolve('firebase-admin/app')), '..');
const { HttpClient } = require(path.join(adminRoot, 'utils/api-request.js'));

const projectId = 'demo-ficus-runtime';
const uid = 'runtime-test-user';
const kid = 'runtime-test-key';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Math.floor(Date.now() / 1000);
process.env.FIREBASE_PROJECT_ID = projectId;
process.env.FIREBASE_CLIENT_EMAIL = `test@${projectId}.iam.gserviceaccount.com`;
process.env.FIREBASE_PRIVATE_KEY = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
const { auth: configuredAuth } = getFirebase();
const app = getApp();
mock.method(app.options.credential, 'getAccessToken', async () => ({ access_token: 'local-test-only', expires_in: 3600 }));
const auth = getAuth(app);
assert.equal(configuredAuth, auth);
const requests = [];
let account = { localId: uid, disabled: false, validSince: String(now - 60) };

// Only the HTTP boundary is replaced. SDK claim, signature, user status and
// revocation checks all run normally. Unknown requests fail without network I/O.
mock.method(HttpClient.prototype, 'send', async (request) => {
  requests.push(request);
  let data;
  if (request.method === 'GET' && request.url ===
      'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com') {
    data = { [kid]: keys.publicKey.export({ format: 'pem', type: 'spki' }) };
  } else if (request.method === 'POST' && request.url ===
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`) {
    assert.deepEqual(request.data, { localId: [uid] });
    data = { users: [account] };
  } else {
    assert.fail(`Unexpected SDK request: ${request.method} ${request.url}`);
  }
  return { status: 200, headers: { 'cache-control': 'public, max-age=3600' }, data, isJson: () => true };
});

after(async () => {
  mock.restoreAll();
  await deleteApp(app);
});

function token(claims = {}, { alg = 'RS256', key = keys.privateKey } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg, kid })}.${encode({
    aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
    sub: uid, iat: now, auth_time: now - 30, exp: now + 3600, ...claims,
  })}`;
  return `${input}.${alg === 'none' ? '' : sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

async function invoke(req) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, res);
  return res;
}

test('cold entry point handles unauthenticated requests without external calls', async () => {
  assert.equal(typeof handler, 'function');
  assert.equal((await invoke({ method: 'GET' })).code, 405);
  assert.equal((await invoke({ method: 'POST', headers: {}, body: {} })).code, 401);
  assert.equal(requests.length, 0);
});

test('real Admin SDK accepts a signed Firebase ID token and checks revocation', async () => {
  assert.equal(getFirebase().auth, auth);
  const decoded = await auth.verifyIdToken(token(), true);
  assert.equal(decoded.uid, uid);
  assert.equal(decoded.aud, projectId);
  assert.ok(requests.some((r) => r.url.endsWith('/accounts:lookup')));
  // Reaching body validation proves the actual API authenticated the token.
  const before = requests.length;
  const response = await invoke({ method: 'POST', headers: { authorization: `Bearer ${token()}` }, body: '{broken' });
  assert.equal(response.code, 400);
  assert.equal(requests.length, before + 1);
  assert.ok(requests.at(-1).url.endsWith('/accounts:lookup'));
});

test('real Admin SDK rejects invalid signatures, claims, algorithms and expired tokens', async () => {
  const invalid = [
    [token({}, { key: wrongKeys.privateKey }), 'auth/argument-error'],
    [token({ aud: 'another-project' }), 'auth/argument-error'],
    [token({ iss: 'https://attacker.invalid' }), 'auth/argument-error'],
    [token({ sub: '' }), 'auth/argument-error'],
    [token({ exp: now - 60 }), 'auth/id-token-expired'],
    [token({}, { alg: 'none' }), 'auth/argument-error'],
  ];
  for (const [value, code] of invalid) {
    const before = requests.length;
    await assert.rejects(auth.verifyIdToken(value, true), { code });
    assert.equal((await invoke({ method: 'POST', headers: { authorization: `Bearer ${value}` }, body: {} })).code, 401);
    assert.equal(requests.length, before, 'invalid tokens must not reach account lookup');
  }
});

test('real Admin SDK and API reject revoked tokens and disabled users', async () => {
  for (const [changes, code] of [
    [{ validSince: String(now) }, 'auth/id-token-revoked'],
    [{ disabled: true }, 'auth/user-disabled'],
  ]) {
    const previous = account;
    account = { ...account, ...changes };
    try {
      await assert.rejects(auth.verifyIdToken(token(), true), { code });
      assert.equal((await invoke({ method: 'POST', headers: { authorization: `Bearer ${token()}` }, body: {} })).code, 401);
    } finally {
      account = previous;
    }
  }
});

test('patched jwks-rsa still imports jose and converts real RSA signing keys', async () => {
  const jwksRsa = require('jwks-rsa');
  const client = jwksRsa({ jwksUri: 'https://jwks.invalid', cache: false, rateLimit: false,
    fetcher: async () => ({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }),
  });
  const key = await client.getSigningKey(kid);
  assert.deepEqual(createPublicKey(key.getPublicKey()).export({ format: 'jwk' }), keys.publicKey.export({ format: 'jwk' }));
});

test('patched Passport callback accepts a valid key and rejects malformed or unsupported tokens', async () => {
  const jwksRsa = require('jwks-rsa');
  const secret = jwksRsa.passportJwtSecret({ jwksUri: 'https://jwks.invalid', cache: false, rateLimit: false,
    fetcher: async () => ({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }),
  });
  const lookup = (value) => new Promise((resolve, reject) => {
    secret({}, value, (error, key) => error ? reject(error) : resolve(key));
  });
  assert.deepEqual(createPublicKey(await lookup(token())).export({ format: 'jwk' }), keys.publicKey.export({ format: 'jwk' }));
  assert.equal(await lookup('malformed'), null);
  assert.equal(await lookup(token({}, { alg: 'none' })), null);
});
