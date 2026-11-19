// Read-only local check. Never print matched values or load cloud credentials.
const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { resolve } = require('node:path');
const cwd = resolve(__dirname, '..');
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args],
  { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const local = existsSync(resolve(cwd, '.env.local')) ? parseEnv(readFileSync(resolve(cwd, '.env.local'), 'utf8')) : {};
const keys = ['YANDEX_ACCESS_KEY_ID', 'YANDEX_SECRET_ACCESS_KEY', 'FIREBASE_PRIVATE_KEY'];
const secrets = keys.flatMap((key) => {
  const value = local[key];
  if (!value || value.length < 12) return [];
  const variants = [value, value.replaceAll('\\n', '\n')];
  if (key === 'FIREBASE_PRIVATE_KEY') variants.push(...value.replaceAll('\\n', '\n').split(/\r?\n/).filter((s) => /^[A-Za-z0-9+/=]{40,}$/.test(s)));
  return variants;
});
const findings = [];
const inspect = (label, value) => {
  if (secrets.some((secret) => value.includes(secret))
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\\nr]+[A-Za-z0-9+/]{40}/.test(value)
    || /"type"\s*:\s*"service_account"/.test(value)) findings.push(label);
};
const forbidden = /(^|\/)(backups|\.vercel)(\/|$)|(^|\/)\.env(?:$|\.(?!example$))|\.(pem|key|p12|pfx)$|(?:service-account|firebase-adminsdk).*\.json$/i;
const candidates = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))];
for (const file of candidates) {
  if (forbidden.test(file)) findings.push(`forbidden Git path: ${file}`);
  if (existsSync(resolve(cwd, file))) inspect(`working file: ${file}`, readFileSync(resolve(cwd, file), 'utf8'));
}
const { readdirSync } = require('node:fs');
const scanBuild = (directory) => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) scanBuild(path);
    else inspect(`build file: ${path.slice(cwd.length + 1)}`, readFileSync(path, 'utf8'));
  }
};
scanBuild(resolve(cwd, 'build'));
// Also inspect staged contents, which can differ from working files.
for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) inspect(`index: ${file}`, git('show', `:${file}`));
// Inspect reachable local Git history, including deleted files, without showing contents.
let blobs = 0;
for (const line of git('rev-list', '--objects', '--all').split('\n').filter(Boolean)) {
  const oid = line.split(' ')[0];
  if (git('cat-file', '-t', oid).trim() !== 'blob') continue;
  blobs += 1;
  inspect(`history blob: ${oid}`, git('cat-file', 'blob', oid));
  const path = line.slice(oid.length + 1);
  if (forbidden.test(path)) findings.push(`forbidden history path: ${path}`);
}
console.log(JSON.stringify({ candidateFiles: candidates.length, historyBlobs: blobs,
  knownLocalSecretsChecked: keys.filter((key) => Boolean(local[key])),
  localClientProjectMatches: local.REACT_APP_FIREBASE_PROJECT_ID === 'my-plants-app-8f6fc',
  localAdminProjectMatches: local.FIREBASE_PROJECT_ID === 'my-plants-app-8f6fc',
  localDeletionDisabled: local.ENABLE_PERMANENT_PLANT_DELETE === 'false',
  findings: [...new Set(findings)] }, null, 2));
if (local.ENABLE_PERMANENT_PLANT_DELETE !== 'false') {
  console.error('Local ENABLE_PERMANENT_PLANT_DELETE must equal false.');
  process.exitCode = 1;
}
if (findings.length) process.exitCode = 1;
