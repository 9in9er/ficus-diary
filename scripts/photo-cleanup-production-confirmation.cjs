#!/usr/bin/env node
// Local operator attestation only. No cloud SDKs, network requests or writes.
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

const PROJECT = 'my-plants-app-8f6fc';
const PRODUCTION_ORIGIN = 'https://www.ficus-diary.ru';
const REQUIRED_FIX_COMMIT = '8dfe7f9f944f37fdba0e3c595dfad92d8680bfc5';
const MAX_CONFIRMATION_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKS = Object.freeze(['deploymentReady', 'fixIncluded', 'photoKeyPreview',
  'previewReopened', 'backupSavedSeparately']);
const FIELDS = ['schemaVersion', 'projectId', 'productionOrigin', 'fixCommit',
  'deployment', 'sourceCommit', 'confirmedAt', 'checks'];

class ConfirmationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function validDeployment(value) {
  if (typeof value !== 'string') return false;
  if (/^dpl_[A-Za-z0-9]{8,128}$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.vercel.app')
      && /^[A-Za-z0-9.-]+$/.test(url.hostname) && !url.port
      // Standard Vercel Git branch aliases move when the branch is redeployed.
      // URL acceptance remains an operator assertion; prefer an immutable dpl_ ID.
      && !url.hostname.includes('-git-')
      && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function validateConfirmation(bytes, { now = Date.now() } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024) {
    throw new ConfirmationError('INVALID_PRODUCTION_CONFIRMATION_SIZE');
  }
  let data;
  try { data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new ConfirmationError('INVALID_PRODUCTION_CONFIRMATION_JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object'
    || Object.keys(data).length !== FIELDS.length || FIELDS.some((field) => !Object.hasOwn(data, field))
    || data.schemaVersion !== 1) throw new ConfirmationError('INVALID_PRODUCTION_CONFIRMATION_SCHEMA');
  if (data.projectId !== PROJECT || data.productionOrigin !== PRODUCTION_ORIGIN
    || data.fixCommit !== REQUIRED_FIX_COMMIT) throw new ConfirmationError('PRODUCTION_CONFIRMATION_SCOPE_MISMATCH');
  if (!validDeployment(data.deployment) || typeof data.sourceCommit !== 'string'
    || !/^[a-f0-9]{40}$/i.test(data.sourceCommit) || /^0{40}$/.test(data.sourceCommit)) {
    throw new ConfirmationError('INVALID_PRODUCTION_DEPLOYMENT_IDENTITY');
  }
  if (typeof data.confirmedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(data.confirmedAt)
    || !Number.isFinite(Date.parse(data.confirmedAt))
    || new Date(data.confirmedAt).toISOString().slice(0, 19) !== data.confirmedAt.slice(0, 19)) {
    throw new ConfirmationError('INVALID_PRODUCTION_CONFIRMATION_TIME');
  }
  const age = now - Date.parse(data.confirmedAt);
  if (age < -5 * 60 * 1000 || age > MAX_CONFIRMATION_AGE_MS) {
    throw new ConfirmationError('PRODUCTION_CONFIRMATION_NOT_CURRENT');
  }
  if (!data.checks || Array.isArray(data.checks) || typeof data.checks !== 'object'
    || Object.keys(data.checks).length !== CHECKS.length
    || CHECKS.some((check) => data.checks[check] !== true)) {
    throw new ConfirmationError('PRODUCTION_CHECKS_NOT_CONFIRMED');
  }
  // Never output arbitrary JSON fields, operator identity, file path or raw parse errors.
  return Object.freeze({ source: 'operator-confirmation-file',
    sha256: createHash('sha256').update(bytes).digest('hex'), projectId: PROJECT,
    productionOrigin: PRODUCTION_ORIGIN, fixCommit: REQUIRED_FIX_COMMIT,
    deployment: data.deployment, sourceCommit: data.sourceCommit.toLowerCase(),
    confirmedAt: data.confirmedAt, checks: Object.freeze({ ...data.checks }),
    independentlyVerifiedWithVercelAPI: false });
}

async function loadConfirmation(filePath, options) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024) throw new ConfirmationError('INVALID_PRODUCTION_CONFIRMATION_SIZE');
    return validateConfirmation(await handle.readFile(), options);
  } catch (error) {
    if (error instanceof ConfirmationError) throw error;
    throw new ConfirmationError('PRODUCTION_CONFIRMATION_READ_FAILED');
  } finally { if (handle) await handle.close(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--file') {
    console.error('Usage: node scripts/photo-cleanup-production-confirmation.cjs --file PATH');
    process.exitCode = 1;
  } else {
    loadConfirmation(args[1]).then((confirmation) => {
      console.log(JSON.stringify({ confirmationValidated: true, productionConfirmation: confirmation }, null, 2));
    }).catch((error) => {
      console.error('Production confirmation rejected:', error instanceof ConfirmationError ? error.code : 'CONFIRMATION_CHECK_FAILED');
      process.exitCode = 1;
    });
  }
}

module.exports = { PROJECT, PRODUCTION_ORIGIN, REQUIRED_FIX_COMMIT, MAX_CONFIRMATION_AGE_MS,
  CHECKS, ConfirmationError, validateConfirmation, loadConfirmation };
