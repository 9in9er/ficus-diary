const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('Preview cold start and Firebase ID token verification without require(esm)', () => {
  // A fresh production process: no warm module cache, .env.local or cloud secrets.
  const env = { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview' };
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = spawnSync(process.execPath, [
    '--no-experimental-require-module', '--test',
    'tests/server/fixtures/photos-runtime.cjs',
  ], { cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
