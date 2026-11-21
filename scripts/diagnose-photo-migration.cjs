#!/usr/bin/env node
// Read-only incident diagnosis. No migration/storage imports and no cloud write endpoints.
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { getFirebase } = require('../server/firebase.cjs');
const { assertProject } = require('./verify-photo-migration.cjs');
const { verifyBackup } = require('./verify-firestore-backup.cjs');
const { ARRAY_START, documentId } = require('./firestore-backup-format.cjs');

const TARGETS = ['mnV2BvHKuxE7XZr5mp1B', 'yJ8a7aS3fLK0tb3dfqkM'];
const FIELDS = ['userId', 'photo', 'photoKey', 'deletedAt', '_photoDeleting'];
const HELP = `Read-only diagnosis of the two remaining photo documents and trash totals.
  node --env-file-if-exists=.env.local scripts/diagnose-photo-migration.cjs
    --project PROJECT_ID --backup "backups/<run-directory>" [--offline]
Only a Firestore runQuery read is permitted; no S3 calls, migrations or cleanup.
Owner UIDs are replaced with report-local owner aliases. Raw document fields are never printed.
--offline examines the verified backup only, without credentials or network.
Optional PHOTO_MIGRATION_USER_ID in the process environment allows exact comparison
with the UID used by the earlier migration. It is never printed.`;

class DiagnosisError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--offline' && !options.offline) { options.offline = true; continue; }
    if (!['--project', '--backup'].includes(flag) || Object.hasOwn(options, flag.slice(2))) {
      throw new DiagnosisError('INVALID_OPTIONS_USE_HELP');
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new DiagnosisError('INVALID_OPTIONS_USE_HELP');
    options[flag.slice(2)] = value;
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project || '') || !options.backup) {
    throw new DiagnosisError('EXPLICIT_PROJECT_AND_BACKUP_REQUIRED');
  }
  return options;
}

const safeId = (id) => /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id
  : `invalid-id-sha256:${createHash('sha256').update(id).digest('hex')}`;
const timestamp = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? value : null;
const typeOf = (field) => field ? ['string', 'boolean', 'null', 'integer', 'double', 'timestamp', 'map', 'array', 'bytes', 'reference', 'geoPoint']
  .find((type) => Object.hasOwn(field, type + 'Value')) || 'unknown' : 'absent';
function truthy(field) {
  if (!field || Object.hasOwn(field, 'nullValue')) return false;
  if (Object.hasOwn(field, 'stringValue')) return Boolean(field.stringValue);
  if (Object.hasOwn(field, 'booleanValue')) return Boolean(field.booleanValue);
  if (Object.hasOwn(field, 'integerValue')) return Number(field.integerValue) !== 0;
  if (Object.hasOwn(field, 'doubleValue')) return Boolean(Number(field.doubleValue));
  return true;
}
const ownerUid = (doc) => doc?.fields?.userId?.stringValue;
const validOwner = (uid) => typeof uid === 'string' && Boolean(uid.trim()) && uid.length <= 128;
const isBase64 = (doc) => /^data:image\/[^;,]+;base64,/.test(doc?.fields?.photo?.stringValue || '');
const isKeyed = (doc) => Boolean(doc?.fields && Object.hasOwn(doc.fields, 'photoKey')
  && !Object.hasOwn(doc.fields.photoKey, 'nullValue'));
const inTrash = (doc) => truthy(doc?.fields?.deletedAt);
const sameField = (a, b, field) => JSON.stringify(a?.fields?.[field]) === JSON.stringify(b?.fields?.[field]);

function state(doc, ownerAlias) {
  if (!doc) return { exists: false };
  const fields = doc.fields || {};
  return { exists: true, owner: ownerAlias(ownerUid(doc)), ownerValid: validOwner(ownerUid(doc)),
    deletedAt: { present: Object.hasOwn(fields, 'deletedAt'), type: typeOf(fields.deletedAt),
      inTrash: inTrash(doc), timestamp: timestamp(fields.deletedAt?.stringValue || fields.deletedAt?.timestampValue) },
    photo: { present: Object.hasOwn(fields, 'photo'), type: typeOf(fields.photo),
      nonEmpty: truthy(fields.photo), base64: isBase64(doc) },
    photoKey: { present: Object.hasOwn(fields, 'photoKey'), type: typeOf(fields.photoKey),
      nonEmpty: truthy(fields.photoKey), countedByVerifier: isKeyed(doc) },
    photoDeleting: { present: Object.hasOwn(fields, '_photoDeleting'), type: typeOf(fields._photoDeleting),
      blocksMigration: truthy(fields._photoDeleting) },
    createTime: timestamp(doc.createTime), updateTime: timestamp(doc.updateTime) };
}

function selection(doc) {
  if (!doc) return 'DOCUMENT_ABSENT';
  if (truthy(doc.fields?.photoKey)) return 'PHOTO_KEY_ALREADY_PRESENT';
  if (inTrash(doc)) return 'TRASH';
  if (truthy(doc.fields?._photoDeleting)) return 'PHOTO_DELETION_IN_PROGRESS';
  if (!isBase64(doc)) return 'NO_BASE64';
  if (!validOwner(ownerUid(doc))) return 'INVALID_OWNER';
  return 'ELIGIBLE_BY_FIELDS';
}

async function inspectLegacyPhoto(doc) {
  const match = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(doc?.fields?.photo?.stringValue || '');
  if (!match) return { valid: false, code: 'UNSUPPORTED_LEGACY_PHOTO' };
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) return { valid: false, code: 'INVALID_LEGACY_SIZE' };
  try {
    // Same conversion limits as migration, entirely in memory; no migration function is called.
    const output = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
      .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .timeout({ seconds: 10 }).webp({ quality: 80 }).toBuffer();
    if (output.length > 5 * 1024 * 1024) return { valid: false, code: 'CONVERTED_PHOTO_TOO_LARGE' };
    return { valid: true, sourceBytes: bytes.length, convertedBytes: output.length };
  } catch { return { valid: false, code: 'LEGACY_DECODE_FAILED' }; }
}

function indexDocuments(documents, project) {
  const indexed = new Map();
  for (const doc of documents) {
    const id = documentId(doc, project);
    if (indexed.has(id)) throw new DiagnosisError('DUPLICATE_DOCUMENT');
    indexed.set(id, doc);
  }
  return indexed;
}

async function loadBackup(directory, project) {
  await verifyBackup(directory); // Validate the full JSON/count/size/SHA-256 before comparison.
  const input = fs.createReadStream(path.join(directory, 'plants.json'));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let metadata;
  const documents = [];
  try {
    for await (const line of lines) {
      if (!metadata) {
        metadata = JSON.parse(`${line.slice(0, -ARRAY_START.length)}}`);
        if (metadata.projectId !== project) throw new DiagnosisError('BACKUP_PROJECT_MISMATCH');
      } else if (!line.startsWith(']')) {
        const entry = JSON.parse(line.startsWith(',') ? line.slice(1) : line);
        // Retain only investigation fields; names, emails, notes etc. are discarded.
        documents.push({ name: entry.document.name, createTime: entry.document.createTime,
          updateTime: entry.document.updateTime, fields: Object.fromEntries(Object.entries(entry.document.fields || {})
            .filter(([field]) => FIELDS.includes(field))) });
      }
    }
  } finally { lines.close(); input.destroy(); }
  return { readTime: timestamp(metadata.readTime), documents: indexDocuments(documents, project) };
}

async function readCurrent({ project, credential, fetchImpl = fetch }) {
  const token = await credential.getAccessToken();
  // This POST executes a SELECT query; no transaction, update, commit or write API exists here.
  const response = await fetchImpl(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'plants' }],
      select: { fields: FIELDS.map((fieldPath) => ({ fieldPath })) },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }] } }),
  });
  if (!response.ok) throw new DiagnosisError(response.status === 403 || response.status === 401
    ? 'FIRESTORE_ACCESS_DENIED' : 'FIRESTORE_READ_FAILED');
  const result = await response.json();
  if (!Array.isArray(result) || result.some((item) => item.error)) throw new DiagnosisError('INVALID_QUERY_RESPONSE');
  const readTimes = result.map((item) => timestamp(item.readTime));
  if (!readTimes.length || readTimes.some((time) => !time) || new Set(readTimes).size !== 1) {
    throw new DiagnosisError('INCONSISTENT_QUERY_READ_TIME');
  }
  return { readTime: readTimes[0], documents: indexDocuments(result.filter((item) => item.document)
    .map((item) => item.document), project) };
}

function counts(documents) {
  const result = { documents: documents.size, withPhotoKey: 0, photoAndPhotoKeyFields: 0,
    base64AndPhotoKey: 0, activeBase64WithoutPhotoKey: 0, trashPlants: 0, trashWithBase64: 0 };
  for (const doc of documents.values()) {
    const fields = doc.fields || {};
    if (isKeyed(doc)) result.withPhotoKey += 1;
    if (Object.hasOwn(fields, 'photo') && Object.hasOwn(fields, 'photoKey')) result.photoAndPhotoKeyFields += 1;
    if (isBase64(doc) && isKeyed(doc)) result.base64AndPhotoKey += 1;
    if (isBase64(doc) && !isKeyed(doc) && !inTrash(doc)) result.activeBase64WithoutPhotoKey += 1;
    if (inTrash(doc)) result.trashPlants += 1;
    if (inTrash(doc) && isBase64(doc)) result.trashWithBase64 += 1;
  }
  return result;
}

async function diagnose({ project, backup, current, migrationUser }) {
  const owners = new Map();
  const ownerAlias = (uid) => {
    if (!validOwner(uid)) return 'invalid-or-missing-owner';
    if (!owners.has(uid)) owners.set(uid, `owner-${owners.size + 1}`);
    return owners.get(uid);
  };
  // Report-local aliases identify equality only, never a raw UID, hash, name or account.
  for (const dataset of [backup, current].filter(Boolean)) {
    for (const doc of dataset.documents.values()) ownerAlias(ownerUid(doc));
  }
  const report = { mode: current ? 'read-only-live-and-backup' : 'offline-backup-only', project,
    backupReadTime: backup.readTime, currentReadTime: current?.readTime || null,
    executionHistoryAvailable: false, migrationOwnerKnown: validOwner(migrationUser),
    migrationOwner: validOwner(migrationUser) ? ownerAlias(migrationUser) : null,
    baseline: counts(backup.documents), current: current ? counts(current.documents) : null, targets: [], owners: [] };
  for (const id of TARGETS) {
    const before = backup.documents.get(id);
    const now = current?.documents.get(id);
    const finding = { plantId: id, backup: state(before, ownerAlias), current: current ? state(now, ownerAlias) : null,
      backupSelection: selection(before), currentSelection: current ? selection(now) : null,
      migrationOwnerMatchInBackup: validOwner(migrationUser) && before ? ownerUid(before) === migrationUser : null,
      migrationOwnerMatchNow: validOwner(migrationUser) && now ? ownerUid(now) === migrationUser : null };
    if (current) {
      finding.changedFieldsSinceBackup = FIELDS.filter((field) => !sameField(before, now, field));
      finding.createdAfterBackup = now ? Date.parse(now.createTime) > Date.parse(backup.readTime) : null;
      finding.updatedAfterBackup = now ? Date.parse(now.updateTime) > Date.parse(backup.readTime) : null;
      finding.localPhotoCheck = now && isBase64(now) ? await inspectLegacyPhoto(now) : null;
      finding.suitableForTargetedMigrationNow = selection(now) === 'ELIGIBLE_BY_FIELDS' && finding.localPhotoCheck?.valid === true;
    }
    report.targets.push(finding);
  }
  for (const [uid, alias] of owners) {
    const scoped = (dataset) => dataset ? counts(new Map([...dataset.documents].filter(([, doc]) => ownerUid(doc) === uid))) : null;
    report.owners.push({ owner: alias, backup: scoped(backup), current: scoped(current) });
  }
  if (current) {
    const transition = (id, before, now) => ({ plantId: safeId(id), ownerBefore: before ? ownerAlias(ownerUid(before)) : null,
      ownerNow: now ? ownerAlias(ownerUid(now)) : null, before: state(before, ownerAlias).deletedAt || null,
      now: state(now, ownerAlias).deletedAt || null, currentUpdateTime: timestamp(now?.updateTime),
      base64Now: isBase64(now), existedInBackup: Boolean(before) });
    report.trashChanges = { enteredTrash: [], leftTrash: [], removedTrashDocuments: [], changedDeletionTimestamp: [] };
    for (const [id, now] of current.documents) {
      const before = backup.documents.get(id);
      if (inTrash(now) && !inTrash(before)) report.trashChanges.enteredTrash.push(transition(id, before, now));
      if (!inTrash(now) && inTrash(before)) report.trashChanges.leftTrash.push(transition(id, before, now));
      if (inTrash(now) && inTrash(before) && !sameField(before, now, 'deletedAt')) {
        report.trashChanges.changedDeletionTimestamp.push(transition(id, before, now));
      }
    }
    for (const [id, before] of backup.documents) {
      if (inTrash(before) && !current.documents.has(id)) report.trashChanges.removedTrashDocuments.push(transition(id, before));
    }
    report.trashChanges.netDelta = report.current.trashPlants - report.baseline.trashPlants;
    report.keyedDocumentsWithoutPhotoField = [...current.documents].filter(([, doc]) => isKeyed(doc)
      && !Object.hasOwn(doc.fields, 'photo')).map(([id, doc]) => ({ plantId: safeId(id), owner: ownerAlias(ownerUid(doc)),
      documentExistedInBackup: backup.documents.has(id),
      photoFieldPresentInBackup: Boolean(backup.documents.get(id)?.fields && Object.hasOwn(backup.documents.get(id).fields, 'photo')),
      photoKeyPresentInBackup: isKeyed(backup.documents.get(id)) }));
  }
  report.historyLimit = 'Backup comparison establishes state changes since backup, not their timing relative to migration. Exact run UID, start/end times and per-document logs are required to prove the historical skip reason.';
  return report;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  const backup = await loadBackup(path.resolve(options.backup), options.project);
  if (options.offline) {
    console.log(JSON.stringify(await diagnose({ project: options.project, backup }), null, 2));
    return;
  }
  assertProject(options.project, process.env);
  const firebase = getFirebase();
  try {
    assertProject(options.project, process.env, firebase);
    const current = await readCurrent({ project: options.project, credential: firebase.auth.app.options.credential });
    const report = await diagnose({ project: options.project, backup, current, migrationUser: process.env.PHOTO_MIGRATION_USER_ID });
    console.log(JSON.stringify(report, null, 2));
  } finally { await firebase.db.terminate(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('Photo diagnosis stopped:', error instanceof DiagnosisError ? error.code : 'READ_OR_VALIDATION_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { TARGETS, FIELDS, parseArgs, loadBackup, readCurrent, counts, diagnose, inspectLegacyPhoto };
