// lib/salesforce/metadata.js
/**
 * Org metadata snapshot, caching, field validation, and record pruning.
 *
 * Responsible for:
 * - Fetching Salesforce describe metadata and caching it to disk
 * - Loading cached describe data for downstream use
 * - Pruning and validating record fields against cached metadata
 *
 * Cache location: meta-data/<ORG_ID>/<ObjectApiName>.json
 */

import fs from 'fs/promises';
import path from 'path';
import { getOrgId } from '../utils/runcontext.js';
import { log } from '../utils/logger.js';

const DEFAULT_META_DIR = path.resolve(process.cwd(), 'meta-data');

// ---------- Private helpers ----------

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function saveJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function loadJSON(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOrgId(conn, explicitOrgId) {
  if (explicitOrgId && String(explicitOrgId).trim()) {
    return String(explicitOrgId).trim();
  }
  const identity = await conn.identity();
  const orgId =
    identity?.organization_id ||
    identity?.organizationId ||
    identity?.organization?.id;
  if (!orgId) {
    throw new Error('metadata.js: Unable to resolve organization Id from connection identity.');
  }
  return orgId;
}

async function resolveOrgMetaDir(conn, { metaDir = DEFAULT_META_DIR, orgId } = {}) {
  const resolvedOrgId = await resolveOrgId(conn, orgId);
  const orgDir = path.join(path.resolve(metaDir), resolvedOrgId);
  await ensureDir(orgDir);
  return { orgId: resolvedOrgId, orgDir };
}

// ---------- Public exports ----------

export async function fetchObjectDescribe(conn, objectName) {
  try {
    const describe = await conn.sobject(objectName).describe();
    return {
      success: true,
      name: describe.name,
      label: describe.label,
      custom: describe.custom,
      createable: describe.createable,
      updateable: describe.updateable,
      keyPrefix: describe.keyPrefix,
      fields: (describe.fields || []).map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        nillable: f.nillable,
        createable: f.createable,
        updateable: f.updateable,
        unique: f.unique,
        defaultedOnCreate: f.defaultedOnCreate,
        length: f.length,
        precision: f.precision,
        scale: f.scale,
        referenceTo: f.referenceTo || [],
        picklistValues: (f.picklistValues || []).map((p) => ({
          value: p.value,
          active: p.active,
        })),
        calculated: f.calculated,
        inlineHelpText: f.inlineHelpText || null,
      })),
    };
  } catch (err) {
    console.error(`Failed to describe object: ${objectName}`, err.message);
    return { success: false, error: `Failed to describe object: ${objectName}` };
  }
}

export async function snapshotOrgMetadata(
  conn,
  { objectNames, metaDir = DEFAULT_META_DIR, orgId, forceRefresh = false, concurrency = 1 } = {}
) {
  if (!Array.isArray(objectNames) || objectNames.length === 0) {
    throw new Error("snapshotOrgMetadata: 'objectNames' must be a non-empty array.");
  }

  const { orgId: resolvedOrgId, orgDir } = await resolveOrgMetaDir(conn, { metaDir, orgId });

  const objects = Array.from(
    new Set(objectNames.map((n) => String(n).trim()).filter(Boolean))
  ).sort();

  await saveJSON(path.join(orgDir, 'objects.json'), objects);

  const unavailableObjects = [];
  const queue = objects.slice();
  const workerCount = Math.max(1, Math.min(concurrency, 8));

  await Promise.all(
    new Array(workerCount).fill(0).map(async () => {
      while (queue.length) {
        const objectName = queue.shift();
        const cacheFile = path.join(orgDir, `${objectName}.json`);
        if (!forceRefresh && (await fileExists(cacheFile))) continue;

        const describe = await fetchObjectDescribe(conn, objectName);
        if (describe.success) {
          await saveJSON(cacheFile, describe);
        } else {
          unavailableObjects.push(objectName);
        }
      }
    })
  );

  return { metaDir: orgDir, orgId: resolvedOrgId, objects, unavailableObjects };
}

export async function loadObjectDescribe(conn, objectName, { metaDir = DEFAULT_META_DIR, orgId } = {}) {
  const { orgDir } = await resolveOrgMetaDir(conn, { metaDir, orgId });
  return loadJSON(path.join(orgDir, `${objectName}.json`));
}

export async function loadCachedObjectList(conn, { metaDir = DEFAULT_META_DIR, orgId } = {}) {
  const { orgDir } = await resolveOrgMetaDir(conn, { metaDir, orgId });
  return loadJSON(path.join(orgDir, 'objects.json'));
}

export async function loadFieldMap(conn, objectName, { metaDir = DEFAULT_META_DIR, orgId } = {}) {
  const describe = await loadObjectDescribe(conn, objectName, { metaDir, orgId });
  const fieldMap = new Map();
  for (const field of describe.fields || []) {
    fieldMap.set(String(field.name).toLowerCase(), field);
  }
  return fieldMap;
}

export function resolveOrgDir({ metaDir = DEFAULT_META_DIR } = {}) {
  const orgId = getOrgId().trim();
  return path.join(path.resolve(metaDir), orgId);
}

export async function ensureObjectMetadataAvailable(objectName, opts = {}) {
  const orgDir = resolveOrgDir(opts);
  const objectsFile = path.join(orgDir, 'objects.json');
  const describeFile = path.join(orgDir, `${objectName}.json`);

  const hasObjectsList = await fileExists(objectsFile);
  const hasDescribeFile = await fileExists(describeFile);

  if (!hasObjectsList || !hasDescribeFile) {
    const orgIdLabel = opts.orgId || process.env.SF_ORG_ID || '<unset>';
    const missing = [];
    if (!hasObjectsList) missing.push(`'${path.relative(process.cwd(), objectsFile)}'`);
    if (!hasDescribeFile) missing.push(`'${path.relative(process.cwd(), describeFile)}'`);
    throw new Error(
      `[metadata-validator] Missing metadata file(s) for ${objectName}: ${missing.join(', ')}.\n` +
      `Expected under meta-data/${orgIdLabel}/. Run a metadata snapshot first (e.g., REFRESH_METADATA=true).`
    );
  }

  return describeFile;
}

export async function loadObjectDescribeFromCache(objectName, opts = {}) {
  const orgDir = resolveOrgDir(opts);
  const describeFile = path.join(orgDir, `${objectName}.json`);
  const raw = await fs.readFile(describeFile, 'utf8');
  return JSON.parse(raw);
}

export function toFieldMap(describe) {
  const fieldMap = new Map();
  for (const field of describe.fields || []) {
    fieldMap.set(String(field.name).toLowerCase(), field);
  }
  return fieldMap;
}

export function validateRecordAgainstFields(objectName, record, fieldMap, { operation = 'insert' } = {}) {
  const problems = [];
  const isWrite = operation === 'insert' || operation === 'upsert';

  for (const fieldName of Object.keys(record)) {
    if (!fieldName || fieldName === 'attributes') continue;

    const fieldDescribe = fieldMap.get(fieldName.toLowerCase());
    if (fieldDescribe) {
      if (isWrite && fieldName !== 'Id' && fieldDescribe.createable === false) {
        problems.push({
          level: 'error',
          code: 'FIELD_NOT_CREATEABLE',
          message: `Field '${fieldName}' on ${objectName} is not createable.`,
        });
      }
      if (!isWrite && fieldName !== 'Id' && fieldDescribe.updateable === false) {
        problems.push({
          level: 'error',
          code: 'FIELD_NOT_UPDATEABLE',
          message: `Field '${fieldName}' on ${objectName} is not updateable.`,
        });
      }
    } else {
      problems.push({
        level: 'error',
        code: 'FIELD_MISSING',
        message: `Unknown field '${fieldName}' on ${objectName}.`,
      });
    }
  }

  return problems;
}

export function validateBatch(objectName, records, fieldMap, { operation = 'insert' } = {}) {
  const allProblems = [];

  for (let i = 0; i < records.length; i++) {
    const recordProblems = validateRecordAgainstFields(
      objectName, records[i] || {}, fieldMap, { operation }
    );
    recordProblems.forEach((p) => { p.recordIndex = i; });
    allProblems.push(...recordProblems);
  }

  const errors = allProblems.filter((p) => p.level === 'error');
  if (errors.length) {
    const summary = errors
      .slice(0, 10)
      .map((e) => `#${e.recordIndex + 1} ${e.code}: ${e.message}`)
      .join('\n  - ');
    throw new Error(
      `[metadata-validator] ${objectName}: ${errors.length} field validation error(s).\n  - ${summary}\n` +
      `Fix mapping/data or refresh metadata cache.`
    );
  }

  return { problems: allProblems };
}

export function pruneRecordFields(
  objectName,
  records,
  fieldMap,
  { operation = 'insert', pruneUnknown = true, pruneNotWritable = true } = {}
) {
  const isWrite = operation === 'insert' || operation === 'upsert';
  const unknownCounts = new Map();
  const notCreateableCounts = new Map();
  const notUpdateableCounts = new Map();

  const pruned = records.map((record) => {
    const out = {};
    for (const [fieldName, value] of Object.entries(record || {})) {
      if (fieldName === 'attributes') {
        out[fieldName] = value;
        continue;
      }

      const fieldDescribe = fieldMap.get(String(fieldName).toLowerCase());
      if (fieldDescribe) {
        if (pruneNotWritable && fieldName !== 'Id') {
          if (isWrite && fieldDescribe.createable === false) {
            notCreateableCounts.set(fieldName, (notCreateableCounts.get(fieldName) || 0) + 1);
            continue;
          }
          if (!isWrite && fieldDescribe.updateable === false) {
            notUpdateableCounts.set(fieldName, (notUpdateableCounts.get(fieldName) || 0) + 1);
            continue;
          }
        }
        out[fieldName] = value;
      } else {
        if (pruneUnknown) {
          unknownCounts.set(fieldName, (unknownCounts.get(fieldName) || 0) + 1);
        } else {
          out[fieldName] = value;
        }
      }
    }
    return out;
  });

  const summarize = (countMap) =>
    Array.from(countMap.entries()).map(([name, count]) => `${name} × ${count}`).join(', ');

  if (unknownCounts.size) {
    log.info(objectName, `🪓 Pruned unknown fields (total ${records.length} record(s)): ${summarize(unknownCounts)}`);
  }
  if (notCreateableCounts.size && isWrite) {
    log.info(objectName, `🪓 Pruned non-createable fields for ${operation}: ${summarize(notCreateableCounts)}`);
  }
  if (notUpdateableCounts.size && !isWrite) {
    log.info(objectName, `🪓 Pruned non-updateable fields for ${operation}: ${summarize(notUpdateableCounts)}`);
  }

  return pruned;
}
