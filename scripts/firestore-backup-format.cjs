const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { createInterface } = require('node:readline');

const FORMAT = 'ficus-firestore-plants/v1';
const ARRAY_START = ',"documents":[';

// ProtoJSON preserves int64 strings, nanoseconds, references, bytes, GeoPoints,
// NaN/Infinity and nested Values. Preserve IEEE negative zero as well.
const stringify = (value) => JSON.stringify(value, (_key, item) => (
  typeof item === 'number' && Object.is(item, -0) ? JSON.rawJSON('-0') : item
));

function documentId(document, projectId) {
  const prefix = `projects/${projectId}/databases/(default)/documents/plants/`;
  if (!document || typeof document.name !== 'string' || !document.name.startsWith(prefix)) {
    throw new Error('Unexpected document resource');
  }
  const id = document.name.slice(prefix.length);
  if (!id || id.includes('/') || !document.createTime || !document.updateTime
    || (document.fields !== undefined && (!document.fields || typeof document.fields !== 'object'
      || Array.isArray(document.fields)))) throw new Error('Invalid document');
  return id;
}

// A deliberately fixed JSON layout lets us validate the entire JSON grammar
// without loading every base64 photo into memory at once. Each document is one
// JSON value on its own line, with commas checked separately.
async function inspectBackup(filePath) {
  const input = createReadStream(filePath);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  input.on('data', (chunk) => { hash.update(chunk); sizeBytes += chunk.length; });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let metadata;
  let footer;
  const ids = new Set();
  try {
    for await (const line of lines) {
      if (!metadata) {
        if (!line.endsWith(ARRAY_START)) throw new Error('Invalid JSON header');
        metadata = JSON.parse(`${line.slice(0, -ARRAY_START.length)}}`);
        if (metadata.format !== FORMAT || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(metadata.projectId)
          || metadata.databaseId !== '(default)' || metadata.collection !== 'plants'
          || typeof metadata.readTime !== 'string') throw new Error('Invalid backup metadata');
      } else if (footer) {
        throw new Error('Unexpected data after JSON footer');
      } else if (line.startsWith(']')) {
        if (!/^\],"documentCount":(0|[1-9]\d*)\}$/.test(line)) throw new Error('Invalid JSON footer');
        footer = JSON.parse(`{${line.slice(2)}`);
      } else {
        if (ids.size > 0 ? !line.startsWith(',{') : !line.startsWith('{')) {
          throw new Error('Invalid JSON document separator');
        }
        const entry = JSON.parse(ids.size > 0 ? line.slice(1) : line);
        if (entry.id !== documentId(entry.document, metadata.projectId) || ids.has(entry.id)) {
          throw new Error('Duplicate or invalid document ID');
        }
        ids.add(entry.id);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!metadata || !footer || footer.documentCount !== ids.size) throw new Error('Incomplete backup');
  return { ...metadata, documentCount: ids.size, sizeBytes, sha256: hash.digest('hex'), jsonValid: true };
}

module.exports = { FORMAT, ARRAY_START, stringify, documentId, inspectBackup };
