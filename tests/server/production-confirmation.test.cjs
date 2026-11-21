const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT, PRODUCTION_ORIGIN, REQUIRED_FIX_COMMIT, CHECKS,
  validateConfirmation, loadConfirmation } = require('../../scripts/photo-cleanup-production-confirmation.cjs');
const { parseArgs, resolveCompatibility, runCleanup } = require('../../scripts/cleanup-base64-photos.cjs');

const now = Date.parse('2026-11-20T12:00:00Z');
const record = () => ({ schemaVersion: 1, projectId: PROJECT, productionOrigin: PRODUCTION_ORIGIN,
  fixCommit: REQUIRED_FIX_COMMIT, deployment: 'dpl_ProductionFixture123', sourceCommit: 'a'.repeat(40),
  confirmedAt: '2026-11-20T11:00:00Z', checks: Object.fromEntries(CHECKS.map((check) => [check, true])) });
const encode = (data) => Buffer.from(JSON.stringify(data));
const baseOptions = { project: PROJECT, apply: false, stopOnError: false };
const secret = 'https://private.invalid/?X-Amz-Signature=DO_NOT_LOG';

async function receipt(t, data = record()) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ficus-confirmation-test-'));
  const file = path.join(folder, 'production.json');
  await fs.writeFile(file, encode(data));
  t.after(async () => {
    // Remove only the exact file and empty temporary directory created by this fixture.
    assert.equal(path.dirname(folder), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('ficus-confirmation-test-'));
    await fs.unlink(file);
    await fs.rmdir(folder);
  });
  return file;
}

test('scoped operator confirmation reports a real byte digest and explicitly distinguishes manual/API verification', () => {
  const bytes = encode(record());
  const confirmation = validateConfirmation(bytes, { now });
  assert.equal(confirmation.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(confirmation.projectId, PROJECT);
  assert.equal(confirmation.fixCommit, REQUIRED_FIX_COMMIT);
  assert.equal(confirmation.source, 'operator-confirmation-file');
  assert.equal(confirmation.independentlyVerifiedWithVercelAPI, false);
  assert.equal(Object.isFrozen(confirmation), true);
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes, Buffer.from('\r\n')]);
  assert.notEqual(validateConfirmation(withBom, { now }).sha256, confirmation.sha256);
});

test('all manual checks must be boolean true; missing checks and boolean override fields fail closed', () => {
  for (const name of CHECKS) {
    for (const value of [false, 'true', 1, null, undefined]) {
      const data = record();
      data.checks[name] = value;
      assert.throws(() => validateConfirmation(encode(data), { now }), { code: 'PRODUCTION_CHECKS_NOT_CONFIRMED' });
    }
  }
  for (const field of ['applyAllowed', 'productionVerified', 'ignoreSafetyChecks']) {
    assert.throws(() => validateConfirmation(encode({ ...record(), [field]: true }), { now }),
      { code: 'INVALID_PRODUCTION_CONFIRMATION_SCHEMA' });
  }
});

test('confirmation is bound to this project, production origin and exact full preview-fix commit', () => {
  for (const patch of [{ projectId: 'other' }, { productionOrigin: 'https://preview.vercel.app' },
    { fixCommit: '8dfe7f9' }, { fixCommit: 'b'.repeat(40) }]) {
    assert.throws(() => validateConfirmation(encode({ ...record(), ...patch }), { now }),
      { code: 'PRODUCTION_CONFIRMATION_SCOPE_MISMATCH' });
  }
});

test('deployment identity rejects placeholders, signed URLs, credentials, other services and abbreviated source commits', () => {
  for (const patch of [{ deployment: 'REPLACE_ME' }, { deployment: secret },
    { deployment: 'https://my-plants-app-git-main-my-plants-apps-projects.vercel.app/' },
    { deployment: 'https://test.vercel.app/?token=secret' }, { deployment: 'https://user:secret@test.vercel.app/' },
    { deployment: 'https://test.vercel.app.evil.invalid/' }, { deployment: 'http://test.vercel.app/' },
    { sourceCommit: '8dfe7f9' }, { sourceCommit: '0'.repeat(40) }]) {
    assert.throws(() => validateConfirmation(encode({ ...record(), ...patch }), { now }),
      { code: 'INVALID_PRODUCTION_DEPLOYMENT_IDENTITY' });
  }
  assert.equal(validateConfirmation(encode({ ...record(), deployment: 'https://test-build.vercel.app' }), { now }).deployment,
    'https://test-build.vercel.app');
});

test('stale, future or malformed confirmation time cannot authorize cleanup', () => {
  for (const confirmedAt of ['2026-11-19T11:59:59Z', '2026-11-20T12:06:00Z']) {
    assert.throws(() => validateConfirmation(encode({ ...record(), confirmedAt }), { now }),
      { code: 'PRODUCTION_CONFIRMATION_NOT_CURRENT' });
  }
  for (const confirmedAt of [null, 'today', '2026-11-20T11:00:00+03:00']) {
    assert.throws(() => validateConfirmation(encode({ ...record(), confirmedAt }), { now }),
      { code: 'INVALID_PRODUCTION_CONFIRMATION_TIME' });
  }
});

test('invalid JSON, oversized receipts, missing files and malformed metadata do not expose their contents', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16 * 1024 + 1), Buffer.from(secret), encode(null), encode([])]) {
    assert.throws(() => validateConfirmation(bytes, { now }));
  }
  await assert.rejects(loadConfirmation(path.join(os.tmpdir(), 'missing-ficus-production-confirmation.json')),
    { code: 'PRODUCTION_CONFIRMATION_READ_FAILED' });
});

test('dry-run validates and reports the attestation; apply additionally requires the reviewed file SHA-256', async (t) => {
  const file = await receipt(t);
  const dry = await resolveCompatibility({ ...baseOptions, productionConfirmation: file }, { now });
  assert.equal(dry.productionVerified, true);
  assert.equal(dry.applyAllowed, true);
  const apply = { ...baseOptions, apply: true, productionConfirmation: file };
  await assert.rejects(resolveCompatibility(apply, { now }), { code: 'PRODUCTION_CONFIRMATION_ACK_REQUIRED' });
  await assert.rejects(resolveCompatibility({ ...apply, confirmProduction: '0'.repeat(64) }, { now }),
    { code: 'PRODUCTION_CONFIRMATION_HASH_MISMATCH' });
  assert.equal((await resolveCompatibility({ ...apply, confirmProduction: dry.confirmation.sha256.toUpperCase() }, { now }))
    .productionVerified, true);
  await fs.appendFile(file, '\n');
  await assert.rejects(resolveCompatibility({ ...apply, confirmProduction: dry.confirmation.sha256 }, { now }),
    { code: 'PRODUCTION_CONFIRMATION_HASH_MISMATCH' });
});

test('a confirmation file never implies apply and does not allow boolean/env overrides', async (t) => {
  const file = await receipt(t);
  const options = parseArgs(['--project', PROJECT, '--production-confirmation', file]);
  assert.equal(options.apply, false);
  const compatibility = await resolveCompatibility(options, { now });
  let writes = 0;
  const report = await runCleanup({ options, compatibility, db: {
    collection: () => ({ orderBy() { return this; }, limit() { return this; }, select() { return this; },
      get: async () => ({ docs: [], size: 0 }) }),
    runTransaction: () => { writes += 1; assert.fail('dry-run must never start a write transaction'); },
  } });
  assert.equal(writes, 0);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.productionVerified, true);
  assert.equal(report.confirmationValidated, true);
  assert.equal(report.productionConfirmation.sha256, compatibility.confirmation.sha256);
  assert.equal(report.removed, 0);
  assert.throws(() => parseArgs(['--project', PROJECT, '--production-confirmation', file, '--confirm-production', 'true']));
  assert.throws(() => parseArgs(['--project', PROJECT, '--production-verified']));
  await assert.rejects(resolveCompatibility({ ...baseOptions, apply: true }), { code: 'PRODUCTION_CONFIRMATION_REQUIRED' });
});

test('local receipt validation CLI runs without cloud credentials and sanitizes rejection diagnostics', async (t) => {
  const data = { ...record(), confirmedAt: new Date().toISOString() };
  const file = await receipt(t, data);
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const result = spawnSync(process.execPath, ['scripts/photo-cleanup-production-confirmation.cjs', '--file', file],
    { env, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).confirmationValidated, true);
  await fs.writeFile(file, secret);
  const rejected = spawnSync(process.execPath, ['scripts/photo-cleanup-production-confirmation.cjs', '--file', file],
    { env, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 1);
  assert.ok(!(rejected.stdout + rejected.stderr).includes(secret));
  assert.ok(!rejected.stderr.includes('Error:'));
});
