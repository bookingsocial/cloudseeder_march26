# CloudSeeder — Full Source Code Reference

## Project Overview

CloudSeeder is a Node.js CLI tool that loads declaratively-configured seed data into Salesforce orgs. It reads JSON pipeline definitions, applies field mappings and transforms, resolves parent-child foreign key references, and writes records via the Salesforce REST, Composite, or Bulk API 2.0.

---

## Folder Structure

```
cloudseeder_march26/
├── .env                                    # Environment variables (SF credentials, flags)
├── README.md                               # Main documentation
├── package.json                            # NPM package config (ESM, dependencies)
│
├── scripts/
│   └── runLoad.js                          # CLI entry point — boots env, auth, runs pipeline
│
├── lib/
│   ├── filters.js                          # Declarative record filter engine
│   ├── loader.js                           # Per-step transform + metadata + commit pipeline
│   ├── config/
│   │   ├── index.js                        # Re-exports all config loaders
│   │   ├── env.js                          # Environment variable reader/validator
│   │   ├── constants.js                    # constants.json loader with env overlay
│   │   ├── pipeline.js                     # pipeline.json loader with env overlay
│   │   ├── step-config.js                  # 4-level merge: base + env + step + inline
│   │   └── utils.js                        # JSON5 reader, deepMerge utility
│   ├── pipeline/
│   │   ├── orchestrator.js                 # Main pipeline execution engine
│   │   ├── dataloader.js                   # Data file loader with per-run cache
│   │   ├── generators.js                   # Generator dispatcher → services/generators.js
│   │   └── toposort.js                     # Topological sort by dependsOn
│   ├── salesforce/
│   │   ├── auth.js                         # jsforce connection + login
│   │   ├── commit.js                       # DML strategies: REST, Composite, Bulk API 2.0
│   │   ├── metadata.js                     # Org describe snapshot, cache, prune, validate
│   │   └── permset.js                      # Permission Set creation + FLS management
│   ├── transform/
│   │   ├── index.js                        # Re-exports full transform public API
│   │   ├── transforms.js                   # Transform ops: assign, copy, rename, remove, coalesce, concat
│   │   ├── shape.js                        # Record shaping: fieldMap, defaults, removeFields
│   │   ├── constants.js                    # ${constants.*} placeholder resolution
│   │   └── ref-solver.js                   # Foreign key reference resolution engine
│   ├── utils/
│   │   ├── logger.js                       # Leveled console logger with ISO timestamps
│   │   ├── duallogger.js                   # Routes logs to both console and file
│   │   ├── runlog.js                       # Per-run file logger (logs/run-YYYYMMDD_Z.log)
│   │   └── runcontext.js                   # Runtime singleton storing orgId
│   └── validators/
│       └── validatematchkeys.js            # Match key validation + auto-creation via Metadata API
│
├── services/
│   └── generators.js                       # Custom generators: junctions, hierarchies, patterns
│
├── config/
│   ├── constants.json                      # Shared constants (e.g., default stage, close date)
│   ├── pipeline.json                       # Pipeline step definitions
│   └── sales/
│       ├── data/
│       │   └── seed.json                   # Sample seed data: Account, Contact, Opportunity
│       └── mappings/
│           ├── Account.json                # Account mapping config
│           ├── Contact.json                # Contact mapping config
│           └── Opportunity.json            # Opportunity mapping config
│
├── requirements/
│   ├── requirements.md                     # Functional and non-functional requirements
│   ├── implementation.md                   # Architecture and module reference
│   └── code.md                             # (this file) Full consolidated source
│
├── planning/                               # Architecture planning docs (ADRs, roadmap, findings)
├── docs/                                   # User-facing docs and use case walkthroughs
├── meta-data/                              # (generated) Org describe cache: meta-data/<ORG_ID>/<Object>.json
└── logs/                                   # (generated) Per-run log files
```

---

## Source Files

---

### `package.json`

```json
{
  "name": "cloud-seeder",
  "version": "1.0.0",
  "description": "Seeding Salesforce environments in the cloud",
  "type": "module",
  "main": "scripts/runLoad.js",
  "scripts": {
    "start": "node scripts/runLoad.js"
  },
  "author": "Bala",
  "license": "Apache 2.0",
  "dependencies": {
    "chalk": "^5.3.0",
    "dotenv": "^16.3.1",
    "jsforce": "^3.10.8",
    "json5": "^2.2.3",
    "jszip": "^3.10.1"
  }
}
```

---

### `.env`

```
SF_USERNAME={username}
SF_PASSWORD={passwordwithtoken}
SF_LOGIN_URL={loginurl}
REFRESH_METADATA=true
AUTO_CREATE_MATCH_KEYS=true
```

---

### `scripts/runLoad.js`

Entry point. Loads env config, authenticates to Salesforce, creates loggers, runs pipeline, writes run report.

```javascript
// scripts/runLoad.js
import 'dotenv/config'; // must be first: loads .env before any other module reads process.env
import path from 'path';
import { fileURLToPath } from 'url';

import { loadEnvConfig } from '../lib/config/env.js';
import { getConnection } from '../lib/salesforce/auth.js';
import { createRunLogSingle } from '../lib/utils/runlog.js';
import { log } from '../lib/utils/logger.js';
import { createDualLogger } from '../lib/utils/duallogger.js';
import { runPipeline } from '../lib/pipeline/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = path.resolve(__dirname, '..');

let runLog = null;

async function main() {
  const cfg = loadEnvConfig();
  runLog = createRunLogSingle('logs');
  const fileLog = (tag, msg) => runLog.write(tag, msg);
  const L = createDualLogger(log, fileLog);

  L.info('System', `Start — ENV=${cfg.loader.envName} DRY_RUN=${cfg.loader.dryRun}`);

  let conn = null;
  if (!cfg.loader.dryRun) {
    conn = await getConnection(cfg.salesforce);
    L.info('System', 'Authenticated to Salesforce ✅');
  } else {
    L.info('System', 'DRY_RUN enabled — will not write to Salesforce');
  }

  const report = await runPipeline(conn, cfg, { cwd: CWD, L });

  runLog.writeJson('System', 'RUN REPORT', report);
  L.info('System', `Completed ✅ • logFile=${runLog.path}`);
  runLog.close();
}

main().catch(async (err) => {
  const msg = err?.message || err?.stack || String(err);
  if (runLog) {
    runLog.write('System', `ERROR❌ ${msg}`);
    runLog.close();
  }
  console.error(`[${new Date().toISOString()}] [System] ERROR❌:`, msg);
  await new Promise(res => setTimeout(res, 10));
  process.exit(1);
});
```

---

### `lib/config/env.js`

Reads and validates all environment variables once at startup. All other modules receive config values as arguments — they do not read `process.env` directly.

```javascript
// lib/config/env.js
export function loadEnvConfig() {
  const required = ['SF_LOGIN_URL', 'SF_USERNAME', 'SF_PASSWORD'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  return {
    salesforce: {
      loginUrl: process.env.SF_LOGIN_URL,
      username: process.env.SF_USERNAME,
      password: process.env.SF_PASSWORD,
    },
    loader: {
      envName:           process.env.LOADER_ENV || process.env.NODE_ENV || 'dev',
      dryRun:            process.env.DRY_RUN === 'true',
      refreshMetadata:   process.env.REFRESH_METADATA === 'true',
      autoCreateKeys:    process.env.AUTO_CREATE_MATCH_KEYS === 'true',
      logLevel:          process.env.LOG_LEVEL || 'info',
      logPrune:          process.env.LOG_PRUNE === 'true',
      debugRefs:         process.env.DEBUG_REFS === 'true',
      metaConcurrency:   Number(process.env.META_CONCURRENCY || 2),
    },
  };
}
```

---

### `lib/config/index.js`

```javascript
export { loadStepConfig } from "./step-config.js";
export { loadPipeline } from "./pipeline.js";
export { loadConstants } from "./constants.js";
export { readJSON, deepMerge } from "./utils.js";
```

---

### `lib/config/constants.js`

Loads `config/constants.json` and merges optional `config/env/<envName>/constants.json` on top.

```javascript
import fs from "fs";
import path from "path";
import { readJSON, deepMerge } from "./utils.js";

export function loadConstants({
  configDir = path.resolve(process.cwd(), "config"),
  envName = process.env.LOADER_ENV || process.env.NODE_ENV || "dev",
} = {}) {
  const basePath = path.join(configDir, "constants.json");
  const envPath = path.join(configDir, "env", envName, "constants.json");

  const base = fs.existsSync(basePath) ? readJSON(basePath) : {};
  const env = fs.existsSync(envPath) ? readJSON(envPath) : {};
  return deepMerge({}, base, env);
}
```

---

### `lib/config/pipeline.js`

Loads `config/pipeline.json` and merges optional `config/env/<envName>/pipeline.json` on top.

```javascript
import fs from "fs";
import path from "path";
import { readJSON, deepMerge } from "./utils.js";

export function loadPipeline({
  configDir = path.resolve(process.cwd(), "config"),
  envName = process.env.LOADER_ENV || process.env.NODE_ENV || "dev",
} = {}) {
  const basePath = path.join(configDir, "pipeline.json");
  if (!fs.existsSync(basePath)) throw new Error(`Missing pipeline at ${basePath}`);
  const envPath = path.join(configDir, "env", envName, "pipeline.json");

  const base = readJSON(basePath);
  const env = fs.existsSync(envPath) ? readJSON(envPath) : {};
  return deepMerge({}, base, env);
}
```

---

### `lib/config/step-config.js`

4-level merge for a single step's mapping config:
1. `config/base/<Object>.json` (optional)
2. `config/env/<envName>/<Object>.json` (optional)
3. `step.configFile` (required)
4. `step.configInline` (optional, highest precedence)

```javascript
// lib/config/step-config.js
import fs from 'fs';
import path from 'path';
import { readJSON, deepMerge } from './utils.js';

export class StepConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepConfigError';
  }
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

const CACHE = new Map();

export function loadStepConfig(step, options = {}) {
  if (!isPlainObject(step)) {
    throw new StepConfigError('loadStepConfig(step) requires a step object.');
  }
  const { object: objectName, configFile, configInline } = step;
  if (!objectName) {
    throw new StepConfigError('loadStepConfig(step): step.object is required.');
  }
  if (!configFile) {
    throw new StepConfigError(`loadStepConfig(step): step.configFile is required for ${objectName}.`);
  }

  const {
    cwd = process.cwd(),
    baseDir = path.resolve(cwd, 'config', 'base'),
    envDir = path.resolve(cwd, 'config', 'env'),
    envName = process.env.NODE_ENV || 'development',
    cache = true,
  } = options;

  const absoluteStepPath = path.isAbsolute(configFile)
    ? configFile
    : path.resolve(cwd, configFile);

  const cacheKey = cache
    ? JSON.stringify({
        objectName,
        absoluteStepPath,
        envName,
        inlineHash: configInline ? stableInlineHash(configInline) : '',
        baseDir,
        envDir,
      })
    : null;

  if (cache && CACHE.has(cacheKey)) {
    return CACHE.get(cacheKey);
  }

  let merged = {};

  // 1) base config (optional)
  const basePath = path.join(baseDir, `${objectName}.json`);
  if (fs.existsSync(basePath)) {
    merged = deepMerge(merged, readJSON(basePath));
  }

  // 2) env overlay (optional)
  const envPath = path.join(envDir, envName, `${objectName}.json`);
  if (fs.existsSync(envPath)) {
    merged = deepMerge(merged, readJSON(envPath));
  }

  // 3) step config (required)
  if (!fs.existsSync(absoluteStepPath)) {
    throw new StepConfigError(
      `loadStepConfig(step): step.configFile not found for ${objectName}: ${absoluteStepPath}`
    );
  }
  merged = deepMerge(merged, readJSON(absoluteStepPath));

  // 4) inline overrides (optional)
  if (configInline && isPlainObject(configInline)) {
    merged = deepMerge(merged, configInline);
  }

  if (!isPlainObject(merged)) {
    throw new StepConfigError(`loadStepConfig(step): resolved config for ${objectName} is empty or invalid.`);
  }

  if (cache) CACHE.set(cacheKey, merged);
  return merged;
}

function stableInlineHash(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export default loadStepConfig;
```

---

### `lib/config/utils.js`

JSON5 file reader (strips BOM, supports comments/trailing commas) and recursive deep merge utility.

```javascript
import fs from "fs";
import JSON5 from "json5";

export function readJSON(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON5.parse(raw);
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepMergePair(target, source) {
  if (source === undefined || source === null) return structuredClone(target) ?? {};
  if (Array.isArray(target) && Array.isArray(source)) return [...source];
  if (isPlainObject(target) && isPlainObject(source)) {
    const out = { ...target };
    for (const [k, v] of Object.entries(source)) {
      out[k] = deepMergePair(out[k], v);
    }
    return out;
  }
  return structuredClone(source);
}

// Deep-merge any number of objects left to right. Arrays are replaced (not concatenated).
export function deepMerge(target, ...sources) {
  return sources.reduce(deepMergePair, structuredClone(target) ?? {});
}
```

---

### `lib/filters.js`

Declarative record filter engine. Supports: `exists`, `missing`, `equals`, `neq`, `in`, `nin`, `regex`, `gt/gte/lt/lte`, `contains`, `startsWith`, `endsWith`, `length`, `all`, `any`, `not`, `expr`.

```javascript
// lib/filters.js

function get(rec, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split(".").reduce((o, k) => (o != null ? o[k] : undefined), rec);
}

function toNum(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function str(val, ci) {
  if (val == null) return "";
  const s = String(val);
  return ci ? s.toLowerCase() : s;
}

function buildExprRunner(expr) {
  const fn = new Function("rec", "ctx", `return (${expr});`);
  return (rec, ctx) => !!fn(rec, ctx);
}

export function matchPredicate(rec, spec, ctx = {}) {
  if (!spec || typeof spec !== "object") return true;

  if (spec.all) {
    const arr = Array.isArray(spec.all) ? spec.all : [spec.all];
    return arr.every((p) => matchPredicate(rec, p, ctx));
  }
  if (spec.any) {
    const arr = Array.isArray(spec.any) ? spec.any : [spec.any];
    return arr.some((p) => matchPredicate(rec, p, ctx));
  }
  if (spec.not) {
    return !matchPredicate(rec, spec.not, ctx);
  }

  if (spec.expr) {
    try {
      const run = buildExprRunner(String(spec.expr));
      return run(rec, ctx);
    } catch (e) {
      if (ctx?.env?.DEBUG_FILTERS) console.warn(`[filter.expr] Failed: ${spec.expr}`, e?.message);
      return false;
    }
  }

  if (spec.exists) {
    const v = get(rec, spec.exists);
    return v !== undefined && v !== null;
  }
  if (spec.missing) {
    const v = get(rec, spec.missing);
    return v === undefined || v === null;
  }
  if (spec.equals) {
    const { field, value, ci } = spec.equals;
    const v = get(rec, field);
    return ci ? str(v, true) === str(value, true) : v === value;
  }
  if (spec.neq) {
    const { field, value, ci } = spec.neq;
    const v = get(rec, field);
    return ci ? str(v, true) !== str(value, true) : v !== value;
  }
  if (spec.in) {
    const { field, values = [], ci } = spec.in;
    const v = get(rec, field);
    if (ci) {
      const hay = values.map((x) => str(x, true));
      return hay.includes(str(v, true));
    }
    return values.includes(v);
  }
  if (spec.nin) {
    const { field, values = [], ci } = spec.nin;
    const v = get(rec, field);
    if (ci) {
      const hay = values.map((x) => str(x, true));
      return !hay.includes(str(v, true));
    }
    return !values.includes(v);
  }
  if (spec.regex) {
    const { field, pattern, flags } = spec.regex;
    const v = get(rec, field);
    if (v == null) return false;
    const rx = new RegExp(pattern, flags || "");
    return rx.test(String(v));
  }
  if (spec.gt || spec.gte || spec.lt || spec.lte) {
    const op = spec.gt ? "gt" : spec.gte ? "gte" : spec.lt ? "lt" : "lte";
    const { field, value } = spec[op];
    const a = toNum(get(rec, field));
    const b = toNum(value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (op === "gt")  return a >  b;
    if (op === "gte") return a >= b;
    if (op === "lt")  return a <  b;
    if (op === "lte") return a <= b;
  }
  if (spec.contains) {
    const { field, value, ci } = spec.contains;
    const v = get(rec, field);
    if (v == null) return false;
    return str(v, ci).includes(str(value, ci));
  }
  if (spec.startsWith) {
    const { field, value, ci } = spec.startsWith;
    const v = get(rec, field);
    if (v == null) return false;
    return str(v, ci).startsWith(str(value, ci));
  }
  if (spec.endsWith) {
    const { field, value, ci } = spec.endsWith;
    const v = get(rec, field);
    if (v == null) return false;
    return str(v, ci).endsWith(str(value, ci));
  }
  if (spec.length) {
    const { field, op = "eq", value } = spec.length;
    const v = get(rec, field);
    const len = v == null ? 0 : String(v).length;
    if (op === "eq")  return len === value;
    if (op === "neq") return len !== value;
    if (op === "gt")  return len >  value;
    if (op === "gte") return len >= value;
    if (op === "lt")  return len <  value;
    if (op === "lte") return len <= value;
    return false;
  }

  return true; // unknown predicate — non-restrictive
}

export function applyFilter(records, filterSpec, ctx = undefined) {
  if (filterSpec === undefined || filterSpec === null || filterSpec === true) return records;
  if (filterSpec === false) return [];
  const preds = Array.isArray(filterSpec) ? filterSpec : [filterSpec];
  return records.filter((rec) => preds.every((p) => matchPredicate(rec, p, ctx)));
}
```

---

### `lib/loader.js`

Per-step pipeline: resolves constants → pre-transforms → shapes record → resolves references → post-transforms → prunes unknown/non-writable fields → metadata validates → required field check → uniqueness check → batches → commits to Salesforce → builds idMap.

```javascript
// lib/loader.js
import { log } from './utils/logger.js';
import {
  shapeRecord,
  applyTransforms,
  resolveConstantsDeep,
  assertRequiredFields,
  resolveReferences,
} from './transform/index.js';
import { commit } from './salesforce/commit.js';
import {
  ensureObjectMetadataAvailable,
  loadObjectDescribeFromCache,
  toFieldMap,
  pruneRecordFields,
  validateBatch
} from './salesforce/metadata.js';

function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}
function get(obj, path) {
  return String(path || '')
    .split('.')
    .reduce((o, p) => (o ? o[p] : undefined), obj);
}
function computeUniqKey(rec, fields = []) {
  return fields.map((f) => JSON.stringify(get(rec, f))).join('|');
}

export async function insertAndMap(conn, objectName, records, cfg, idMaps = {}, constants = {}) {
  const matchKey = cfg?.identify?.matchKey;
  if (!matchKey) {
    log.error(objectName, `❌ Missing identify.matchKey`);
    throw new Error(`Mapping for ${objectName} missing identify.matchKey`);
  }

  const cfgResolved = resolveConstantsDeep(cfg, constants);

  const pre = cfgResolved?.transform?.pre || [];
  const post = cfgResolved?.transform?.post || [];
  const req = cfgResolved?.validate?.requiredFields || [];
  const uniqBy = cfgResolved?.validate?.uniqueBy || [];
  const strategy = cfgResolved?.strategy || { operation: 'insert', api: 'rest' };
  const op = String(strategy.operation || 'insert').toLowerCase();

  // Ensure metadata cache exists
  await ensureObjectMetadataAvailable(objectName);
  const describe = await loadObjectDescribeFromCache(objectName);
  const fieldMap = toFieldMap(describe);

  // Transform all records
  const transformedRecord = records.map((r) => {
    let rec = { ...r };
    rec = resolveConstantsDeep(rec, constants);
    rec = applyTransforms(rec, pre);
    rec = shapeRecord(rec, cfgResolved);
    rec = resolveReferences(rec, cfgResolved?.references || [], idMaps, objectName);
    rec = applyTransforms(rec, post);
    return rec;
  });

  // Prune unknown and non-writable fields
  const pruned = pruneRecordFields(objectName, transformedRecord, fieldMap, {
    operation: op,
    pruneUnknown: true,
    pruneNotWritable: true
  });

  if (pruned.length && process.env.LOG_PRUNE === 'true') {
    const diff = (a, b) => Object.keys(a).filter(k => !(k in b));
    log.info("PRUNING", `[${objectName}] pruned fields (first 2):`,
      pruned.slice(0,2).map((r,i)=>({rec:i+1, removed: diff(transformedRecord[i], r)})));
  }

  // Field-level metadata validation
  validateBatch(objectName, pruned, fieldMap, { operation: op });

  // Required field validation
  for (const rec of pruned) {
    assertRequiredFields(rec, req, `${objectName}:${get(rec, matchKey) ?? 'unknown'}`);
  }

  // Client-side uniqueness guard
  if (uniqBy.length > 0) {
    const seen = new Set();
    for (const rec of pruned) {
      const uk = computeUniqKey(rec, uniqBy);
      if (seen.has(uk)) {
        throw new Error(
          `Uniqueness violated for ${objectName}: fields [${uniqBy.join(', ')}], key=${uk}`
        );
      }
      seen.add(uk);
    }
  }

  const idMap = {};
  const batchSize = cfgResolved?.strategy?.batchSize || 200;
  const batches = chunk(pruned, batchSize);

  log.info(objectName, `Built ${pruned.length} records ready for ${strategy.operation}`);

  for (const batch of batches) {
    const results = await commit(conn, objectName, batch, strategy);
    let processedRecords = [];
    if(results.failures.length > 0){
      log.info(objectName, `Commit ERROR ${objectName} : ${results.failures}`);
    } else {
      processedRecords = results.processedRecords;
    }

    const arr = Array.isArray(processedRecords) ? processedRecords : [processedRecords];

    if(strategy.operation === 'upsert'){
      const extField = strategy.externalIdField;
      arr.forEach((rec) => {
        const sid = rec.Id || rec.id || rec.upsertedId || (rec[0] && rec[0].id);
        const key = rec[extField];
        if (sid && key) {
          idMap[key] = sid;
        } else {
          const msg = JSON.stringify(rec?.errors || rec || {});
          log.info(objectName, `ERROR ${objectName} [${key ?? 'UNKNOWN'}]: ${msg}`);
        }
      });
    } else {
      arr.forEach((res, i) => {
        const key = get(batch[i], matchKey);
        if (res && (res.success === true || res.id || res.upsertedId)) {
          const sid = res.id || res.upsertedId || (res[0] && res[0].id);
          if (sid) idMap[key] = sid;
        } else {
          const msg = JSON.stringify(res?.errors || res || {});
          log.info(objectName, `ERROR ${objectName} [${key}]: ${msg}`);
        }
      });
    }
  }

  return idMap;
}
```

---

### `lib/pipeline/orchestrator.js`

Main pipeline execution engine. Loads pipeline config → snapshots metadata → topo-sorts steps → validates match keys → executes each step (filter → generate or direct → insertAndMap) → returns run report.

```javascript
// lib/pipeline/orchestrator.js
import path from 'path';
import { applyFilter } from '../filters.js';
import { insertAndMap } from '../loader.js';
import { loadStepConfig, loadPipeline, loadConstants } from '../config/index.js';
import { validateMatchKeysFromSnapshots } from '../validators/validatematchkeys.js';
import { snapshotOrgMetadata } from '../salesforce/metadata.js';
import { setOrgId } from '../utils/runcontext.js';
import { topoSortSteps } from './toposort.js';
import { runGenerator } from './generators.js';
import { loadDataFile } from './dataloader.js';

const ms = (s, e) => `${(e - s).toLocaleString()} ms`;

function upsertIdMap(store, objectName, newMap, { preferExisting = true } = {}) {
  const current = store[objectName] || {};
  store[objectName] = preferExisting ? { ...newMap, ...current } : { ...current, ...newMap };
}

export async function runPipeline(conn, cfg, { cwd, L }) {
  const { envName: ENV_NAME, dryRun: DRY_RUN, refreshMetadata, metaConcurrency } = cfg.loader;
  const metaDir = path.resolve(cwd, 'meta-data');
  const totalStart = Date.now();

  const constants = loadConstants({ envName: ENV_NAME });
  const pipelineCfg = loadPipeline({ envName: ENV_NAME });
  const effectiveDryRun = DRY_RUN || Boolean(pipelineCfg.dryRun);

  if (!pipelineCfg.steps || !Array.isArray(pipelineCfg.steps) || pipelineCfg.steps.length === 0) {
    throw new Error("pipeline.json missing non-empty 'steps' array");
  }

  const pipelineObjects = Array.from(
    new Set(
      (pipelineCfg.steps || [])
        .map(s => String(s.object || '').trim())
        .filter(Boolean)
    )
  ).sort();

  // Metadata snapshot
  let snapshotOrgId = null;
  if (conn) {
    L.info('SNAPSHOT', `Starting… objects=${pipelineObjects.length}`);
    const snapshot = await snapshotOrgMetadata(conn, {
      objectNames: pipelineObjects,
      metaDir,
      orgId: undefined,
      forceRefresh: refreshMetadata,
      concurrency: metaConcurrency,
    });
    if (snapshot.unavailableObjects.length > 0) {
      const msg = `Metadata snapshot failed; unavailable=${snapshot.unavailableObjects.join(',')}`;
      L.error('SNAPSHOT', msg);
      throw new Error('Snapshot failed');
    }
    snapshotOrgId = snapshot.orgId;
    setOrgId(snapshot.orgId);
    L.info('System', `Metadata snapshot complete ✅ orgId=${snapshot.orgId}`);
  } else {
    L.warn('System', 'Skipping metadata snapshot (no connection in DRY_RUN)');
  }

  // Topological sort + match key validation
  const stepsOrdered = topoSortSteps(pipelineCfg.steps);
  L.info('System', `Total Steps: ${stepsOrdered.length}`);

  if (conn && snapshotOrgId) {
    await validateMatchKeysFromSnapshots({
      steps: stepsOrdered,
      metaDir,
      orgId: snapshotOrgId,
      loadStepConfig,
      envName: ENV_NAME,
      cwd,
      logFn: null,
      consoleLog: L,
      conn,
    });
  }

  // Step execution loop
  const idMaps = Object.create(null);
  const runReport = {
    env: ENV_NAME,
    dryRun: effectiveDryRun,
    startedAt: new Date(totalStart).toISOString(),
    steps: [],
    totals: { attempted: 0, insertedOrUpserted: 0, errors: 0 },
  };

  let stepIndex = 0;
  for (const step of stepsOrdered) {
    stepIndex++;
    if (!step.object) throw new Error(`Step missing 'object'. Step: ${JSON.stringify(step)}`);
    if (!step.dataFile) throw new Error(`Step for ${step.object} missing 'dataFile'`);
    if (!step.configFile) throw new Error(`Step for ${step.object} must include 'configFile'.`);

    const obj = step.object;
    L.info(obj, `START 🚀 #${stepIndex} [${obj}] Using config file=${step.configFile}`);

    const stepCfg = loadStepConfig(step, { envName: ENV_NAME, cwd, cache: true });
    const rawData = loadDataFile(step.dataFile, cwd);
    const baseData = step.dataKey ? rawData[step.dataKey] : rawData;
    if (!Array.isArray(baseData)) {
      const keys = Array.isArray(rawData) ? '(root is array)' : Object.keys(rawData || {});
      throw new Error(`Data at key '${step.dataKey || '<root>'}' for ${obj} is not an array. Keys: ${keys}`);
    }

    const working = applyFilter(baseData, step.filter);
    const mode = (step.mode || 'direct').toLowerCase();
    L.info(obj, `Records to process: ${working.length} (mode=${mode})`);

    let finalData;
    if (mode === 'generate') {
      L.info(obj, `Running generator: ${step.generator}`);
      finalData = runGenerator(step, rawData, idMaps);
      if (!Array.isArray(finalData)) {
        throw new Error(`Generator '${step.generator}' for ${obj} did not return an array`);
      }
    } else {
      finalData = working;
    }

    L.info(obj, `Processed record count: ${finalData.length}`);

    const recStart = Date.now();
    let idMap = {};
    let okCount = 0;
    let errCount = 0;

    if (effectiveDryRun) {
      const sample = finalData.slice(0, Math.min(3, finalData.length));
      L.info(obj, `DRY_RUN sample: ${JSON.stringify(sample)}`);
      okCount = finalData.length;
    } else {
      idMap = await insertAndMap(conn, obj, finalData, stepCfg, idMaps, constants);
      okCount = Object.keys(idMap).length;
      errCount = Math.max(0, finalData.length - okCount);
      upsertIdMap(idMaps, obj, idMap, { preferExisting: true });
    }

    const recEnd = Date.now();
    const summary = `ok=${okCount} errors=${errCount} elapsed=${ms(recStart, recEnd)}`;
    L.info(obj, `SUMMARY ✅ ${summary}`);

    runReport.steps.push({
      object: obj,
      dataFile: step.dataFile,
      dataKey: step.dataKey || '<root>',
      mode: (step.mode || 'direct').toLowerCase(),
      generator: step.generator || null,
      configFile: step.configFile,
      attempted: finalData.length,
      ok: okCount,
      errors: errCount,
      elapsedMs: recEnd - recStart,
    });
    runReport.totals.attempted += finalData.length;
    runReport.totals.insertedOrUpserted += okCount;
    runReport.totals.errors += errCount;
  }

  const totalEnd = Date.now();
  runReport.finishedAt = new Date(totalEnd).toISOString();
  runReport.totalElapsedMs = totalEnd - totalStart;

  return runReport;
}
```

---

### `lib/pipeline/dataloader.js`

```javascript
// lib/pipeline/dataloader.js
import path from 'path';
import { readJSON } from '../config/utils.js';

const _cache = Object.create(null);

export function loadDataFile(absOrRel, cwd) {
  const filePath = path.isAbsolute(absOrRel) ? absOrRel : path.join(cwd, absOrRel);
  if (!_cache[filePath]) {
    _cache[filePath] = readJSON(filePath);
  }
  return _cache[filePath];
}
```

---

### `lib/pipeline/generators.js`

```javascript
// lib/pipeline/generators.js
import { generators as legacyGenerators } from '../../services/generators.js';

export function runGenerator(step, rawData, idMaps) {
  const name = step.generator;
  const fn = legacyGenerators && legacyGenerators[name];
  if (!fn) {
    throw new Error(
      `Unknown generator '${name}'. Add it to services/generators.js or adjust pipeline.`
    );
  }
  return fn(rawData, idMaps);
}
```

---

### `lib/pipeline/toposort.js`

Kahn's algorithm topological sort. Breaks ties by original JSON order.

```javascript
// lib/pipeline/toposort.js
import { log } from '../utils/logger.js';

export function topoSortSteps(steps) {
  const indeg = new Array(steps.length).fill(0);
  const adj = steps.map(() => []);

  for (let i = 0; i < steps.length; i++) {
    const deps = steps[i].dependsOn || [];
    if (!deps.length) continue;
    for (let j = 0; j < steps.length; j++) {
      if (i === j) continue;
      const outObj = steps[j].object;
      if (deps.includes(outObj)) {
        adj[j].push(i);
        indeg[i]++;
      }
    }
  }

  const q = [];
  for (let i = 0; i < steps.length; i++) {
    if (indeg[i] === 0) q.push(i);
  }

  const order = [];
  while (q.length) {
    const u = q.sort((a, b) => a - b).shift();
    order.push(u);
    for (const v of adj[u]) {
      indeg[v]--;
      if (indeg[v] === 0) q.push(v);
    }
  }

  if (order.length !== steps.length) {
    log.warn('System', 'dependsOn produced a cycle; using original order.');
    return steps;
  }
  return order.map((idx) => steps[idx]);
}
```

---

### `lib/salesforce/auth.js`

```javascript
// lib/salesforce/auth.js
import jsforce from "jsforce";

export const getConnection = async ({ loginUrl, username, password }) => {
  const conn = new jsforce.Connection({ loginUrl });
  await conn.login(username, password);
  return conn;
};
```

---

### `lib/salesforce/commit.js`

Three commit strategies: REST (batch insert/upsert), Composite (sequential per-record fallback), Bulk API 2.0 (loadAndWaitForResults).

```javascript
// lib/salesforce/commit.js
import { log } from '../utils/logger.js';

async function commitREST(conn, objectName, batch, strategy) {
  const normalizeResults = (res) => (Array.isArray(res) ? res : [res]);
  const toMessages = (errs) => {
    if (!errs) return [];
    if (Array.isArray(errs)) return errs.map(e => e?.message || e?.errorCode || JSON.stringify(e));
    return [errs.message || errs.errorCode || JSON.stringify(errs)];
  };
  const getKey = (row, extField, fallback, i) =>
    row?.[extField] ?? row?.Id ?? fallback ?? `row#${i}`;

  if (strategy.operation !== 'upsert') {
    const insertRes = await conn.sobject(objectName).insert(batch);
    return {
      operation: 'insert',
      results: normalizeResults(insertRes),
      created: normalizeResults(insertRes).filter(r => r?.success).map((r, i) => ({ index: i, id: r.id })),
      failures: normalizeResults(insertRes).filter(r => r && r.success === false)
        .map((r, i) => ({ index: i, id: r.id, messages: toMessages(r.errors) })),
    };
  }

  const externalIdField = strategy.externalIdField;
  if (!externalIdField) throw new Error('Missing strategy.externalIdField for upsert');

  for (let i = 0; i < batch.length; i++) {
    if (!batch[i][externalIdField]) {
      throw new Error(`Missing ${externalIdField} just before upsert for ${objectName} row#${i}`);
    }
  }

  const raw = await conn.sobject(objectName).upsert(batch, externalIdField);
  const results = normalizeResults(raw);
  const created = [], updated = [], failures = [];

  for (let i = 0; i < batch.length; i++) {
    const inRec = batch[i];
    const r = results[i];
    if (!r) {
      failures.push({ index: i, key: getKey(inRec, externalIdField, null, i), id: undefined, messages: ['No result returned'] });
      continue;
    }
    if (r.success === true) {
      const entry = { index: i, key: getKey(inRec, externalIdField, r.id, i), id: r.id, externalId: inRec[externalIdField] };
      if (r.created) created.push(entry); else updated.push(entry);
    } else {
      failures.push({ index: i, key: getKey(inRec, externalIdField, r.id, i), id: r.id, externalId: inRec[externalIdField], messages: toMessages(r.errors) });
    }
  }

  const verifyExternalIds = [...created, ...updated].map(e => e.externalId).filter(Boolean);
  let processedRecords = [];
  if (verifyExternalIds.length > 0) {
    processedRecords = await conn.sobject(objectName)
      .find({ [externalIdField]: { $in: verifyExternalIds } }, `Id,${externalIdField}`);
  }

  if (created.length) log.info("COMMIT", `[${objectName}] Created: ${created.length}`);
  if (updated.length) log.info("COMMIT", `[${objectName}] Updated: ${updated.length}`);
  if (failures.length) {
    log.error("COMMIT", `[${objectName}] Failures: ${failures.length}`);
    for (const f of failures) {
      log.error("COMMIT", `  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) log.error("COMMIT", `     - ${m}`);
    }
  }

  return { operation: 'upsert', externalIdField, results, created, updated, failures, processedRecords };
}

async function commitComposite(conn, objectName, batch, strategy) {
  const op = strategy.operation || 'insert';
  const externalIdField = strategy.externalIdField || null;
  const created = [], updated = [], failures = [];

  for (let i = 0; i < batch.length; i++) {
    const rec = batch[i];
    try {
      let res;
      if (op === 'upsert') {
        res = await conn.sobject(objectName).upsert(rec, externalIdField);
      } else {
        res = await conn.sobject(objectName).insert(rec);
      }
      const r = Array.isArray(res) ? res[0] : res;
      if (r?.success) {
        const entry = { index: i, key: (externalIdField && rec[externalIdField]) ?? rec.Id ?? `row#${i}`, id: r.id, externalId: externalIdField ? rec[externalIdField] : undefined };
        if (r.created) created.push(entry); else updated.push(entry);
      } else {
        failures.push({ index: i, key: (externalIdField && rec[externalIdField]) ?? `row#${i}`, id: r?.id, messages: [r?.errors?.[0]?.message || 'Unknown failure'] });
      }
    } catch (e) {
      failures.push({ index: i, key: (externalIdField && rec[externalIdField]) ?? `row#${i}`, id: undefined, messages: [e.message] });
    }
  }

  if (created.length) log.info('COMMIT', `[${objectName}] Created: ${created.length}`);
  if (updated.length) log.info('COMMIT', `[${objectName}] Updated: ${updated.length}`);
  if (failures.length) {
    log.error('COMMIT', `[${objectName}] Failures: ${failures.length}`);
    for (const f of failures) {
      log.error('COMMIT', `  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) log.error('COMMIT', `     - ${m}`);
    }
  }

  return { operation: op, externalIdField, created, updated, failures, processedRecords: [] };
}

async function commitBulk(conn, objectName, batch, strategy) {
  const toMsgs = (errs) => Array.isArray(errs)
    ? errs.map(e => e?.message || e?.errorCode || String(e))
    : (errs ? [String(errs)] : []);
  const getKey = (row, extField, fallback, i) =>
    (extField && row?.[extField]) || row?.Id || fallback || `row#${i}`;
  const firstNonEmpty = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    return undefined;
  };

  const op = (strategy.operation || '').toLowerCase();
  if (!['insert', 'upsert'].includes(op)) {
    throw new Error(`Bulk API implemented for insert|upsert only. Got: ${strategy.operation}`);
  }
  const externalIdField = op === 'upsert' ? (strategy.externalIdField || strategy.externalIdFieldName) : null;
  if (op === 'upsert' && !externalIdField) throw new Error('Missing strategy.externalIdField for bulk upsert');
  if (op === 'upsert') {
    for (let i = 0; i < batch.length; i++) {
      if (!batch[i] || !String(batch[i][externalIdField] ?? '').trim()) {
        throw new Error(`Missing ${externalIdField} just before bulk upsert for ${objectName} row#${i}`);
      }
    }
  }

  const pollTimeout  = strategy.pollTimeoutMs  ?? 10 * 60 * 1000;
  const pollInterval = strategy.pollIntervalMs ?? 2000;

  const {
    jobInfo,
    successfulResults = [],
    failedResults = [],
    unprocessedRecords = []
  } = await conn.bulk2.loadAndWaitForResults({
    object: objectName,
    operation: op,
    ...(op === 'upsert' ? { externalIdFieldName: externalIdField } : {}),
    input: batch,
    pollTimeout,
    pollInterval,
  });

  const successesByKey = new Map();
  const failuresByKey  = new Map();

  for (const r of successfulResults) {
    const key = firstNonEmpty(externalIdField && r[externalIdField], r.sf__Id, r.Id);
    successesByKey.set(key || Symbol('idx'), r);
  }
  for (const r of failedResults) {
    const key = firstNonEmpty(externalIdField && r[externalIdField], r.Id);
    const msg = r.sf__Error ? String(r.sf__Error) : 'Unknown error';
    const arr = failuresByKey.get(key || Symbol('idx')) || [];
    arr.push({ message: msg });
    failuresByKey.set(key || Symbol('idx'), arr);
  }

  const results = batch.map((row, i) => {
    const key = getKey(row, externalIdField, null, i);
    if (successesByKey.has(key)) {
      const sr = successesByKey.get(key);
      return { success: true, created: String(sr.sf__Created ?? '').toLowerCase() === 'true', id: sr.sf__Id || sr.Id, errors: [] };
    }
    if (failuresByKey.has(key)) {
      return { success: false, created: false, id: undefined, errors: failuresByKey.get(key) };
    }
    if (op === 'insert') {
      const sr = successfulResults[i];
      if (sr?.sf__Id) return { success: true, created: String(sr.sf__Created ?? '').toLowerCase() === 'true', id: sr.sf__Id, errors: [] };
      const fr = failedResults[i];
      if (fr?.sf__Error) return { success: false, created: false, id: undefined, errors: [{ message: String(fr.sf__Error) }] };
    }
    return { success: false, created: false, id: undefined, errors: [{ message: 'Row not present in success or failure results' }] };
  });

  const created = [], updated = [], failures = [];
  for (let i = 0; i < batch.length; i++) {
    const inRec = batch[i];
    const r = results[i];
    if (!r || !r.success) {
      failures.push({ index: i, key: getKey(inRec, externalIdField, r?.id, i), id: r?.id, externalId: externalIdField ? inRec?.[externalIdField] : undefined, messages: toMsgs(r?.errors) });
      continue;
    }
    const entry = { index: i, key: getKey(inRec, externalIdField, r.id, i), id: r.id, externalId: externalIdField ? inRec?.[externalIdField] : undefined };
    if (op === 'insert' || r.created) created.push(entry); else updated.push(entry);
  }

  let processedRecords = [];
  try {
    if (op === 'upsert') {
      const exts = [...created, ...updated].map(e => e.externalId).filter(Boolean);
      if (exts.length) processedRecords = await conn.sobject(objectName).find({ [externalIdField]: { $in: exts } }, `Id,${externalIdField}`);
    } else {
      const ids = created.map(e => e.id).filter(Boolean);
      if (ids.length) processedRecords = await conn.sobject(objectName).find({ Id: { $in: ids } }, 'Id');
    }
  } catch (e) {
    log.warn('COMMIT', `[${objectName}][Bulk2] Verify query skipped: ${e.message}`);
  }

  if (created.length) log.info("COMMIT", `[${objectName}] Created: ${created.length}`);
  if (updated.length) log.info("COMMIT", `[${objectName}] Updated: ${updated.length}`);
  if (failures.length) {
    log.error("COMMIT", `[${objectName}][Bulk2] Failures: ${failures.length}`);
    for (const f of failures) {
      log.error("COMMIT", `  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) log.error("COMMIT", `     - ${m}`);
    }
  }

  return { operation: op, externalIdField: externalIdField || null, jobInfo, successfulResults, failedResults, unprocessedRecords, results, created, updated, failures, processedRecords };
}

export async function commit(conn, objectName, batch, strategy) {
  const api = strategy.api || 'rest';
  if (api === 'composite') return commitComposite(conn, objectName, batch, strategy);
  if (api === 'bulk') return commitBulk(conn, objectName, batch, strategy);
  return commitREST(conn, objectName, batch, strategy);
}
```

---

### `lib/salesforce/metadata.js`

Fetch, cache, and validate Salesforce org metadata. Cache stored at `meta-data/<ORG_ID>/<Object>.json`. Provides pruning (unknown/non-writable fields) and batch field validation.

```javascript
// lib/salesforce/metadata.js
import fs from 'fs/promises';
import path from 'path';
import { getOrgId } from '../utils/runcontext.js';
import { log } from '../utils/logger.js';

const DEFAULT_META_DIR = path.resolve(process.cwd(), 'meta-data');

async function ensureDir(dirPath) { await fs.mkdir(dirPath, { recursive: true }); }
async function saveJSON(filePath, data) { await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8'); }
async function loadJSON(filePath) { const raw = await fs.readFile(filePath, 'utf8'); return JSON.parse(raw); }
async function fileExists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

async function resolveOrgId(conn, explicitOrgId) {
  if (explicitOrgId && String(explicitOrgId).trim()) return String(explicitOrgId).trim();
  const identity = await conn.identity();
  const orgId = identity?.organization_id || identity?.organizationId || identity?.organization?.id;
  if (!orgId) throw new Error('metadata.js: Unable to resolve organization Id from connection identity.');
  return orgId;
}

async function resolveOrgMetaDir(conn, { metaDir = DEFAULT_META_DIR, orgId } = {}) {
  const resolvedOrgId = await resolveOrgId(conn, orgId);
  const orgDir = path.join(path.resolve(metaDir), resolvedOrgId);
  await ensureDir(orgDir);
  return { orgId: resolvedOrgId, orgDir };
}

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
        name: f.name, label: f.label, type: f.type, nillable: f.nillable,
        createable: f.createable, updateable: f.updateable, unique: f.unique,
        defaultedOnCreate: f.defaultedOnCreate, length: f.length,
        precision: f.precision, scale: f.scale,
        referenceTo: f.referenceTo || [],
        picklistValues: (f.picklistValues || []).map((p) => ({ value: p.value, active: p.active })),
        calculated: f.calculated, inlineHelpText: f.inlineHelpText || null,
      })),
    };
  } catch (err) {
    console.error(`Failed to describe object: ${objectName}`, err.message);
    return { success: false, error: `Failed to describe object: ${objectName}` };
  }
}

export async function snapshotOrgMetadata(conn, { objectNames, metaDir = DEFAULT_META_DIR, orgId, forceRefresh = false, concurrency = 1 } = {}) {
  if (!Array.isArray(objectNames) || objectNames.length === 0) {
    throw new Error("snapshotOrgMetadata: 'objectNames' must be a non-empty array.");
  }
  const { orgId: resolvedOrgId, orgDir } = await resolveOrgMetaDir(conn, { metaDir, orgId });
  const objects = Array.from(new Set(objectNames.map((n) => String(n).trim()).filter(Boolean))).sort();
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
        if (describe.success) { await saveJSON(cacheFile, describe); }
        else { unavailableObjects.push(objectName); }
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
  for (const field of describe.fields || []) fieldMap.set(String(field.name).toLowerCase(), field);
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
  for (const field of describe.fields || []) fieldMap.set(String(field.name).toLowerCase(), field);
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
        problems.push({ level: 'error', code: 'FIELD_NOT_CREATEABLE', message: `Field '${fieldName}' on ${objectName} is not createable.` });
      }
      if (!isWrite && fieldName !== 'Id' && fieldDescribe.updateable === false) {
        problems.push({ level: 'error', code: 'FIELD_NOT_UPDATEABLE', message: `Field '${fieldName}' on ${objectName} is not updateable.` });
      }
    } else {
      problems.push({ level: 'error', code: 'FIELD_MISSING', message: `Unknown field '${fieldName}' on ${objectName}.` });
    }
  }
  return problems;
}

export function validateBatch(objectName, records, fieldMap, { operation = 'insert' } = {}) {
  const allProblems = [];
  for (let i = 0; i < records.length; i++) {
    const recordProblems = validateRecordAgainstFields(objectName, records[i] || {}, fieldMap, { operation });
    recordProblems.forEach((p) => { p.recordIndex = i; });
    allProblems.push(...recordProblems);
  }
  const errors = allProblems.filter((p) => p.level === 'error');
  if (errors.length) {
    const summary = errors.slice(0, 10).map((e) => `#${e.recordIndex + 1} ${e.code}: ${e.message}`).join('\n  - ');
    throw new Error(
      `[metadata-validator] ${objectName}: ${errors.length} field validation error(s).\n  - ${summary}\nFix mapping/data or refresh metadata cache.`
    );
  }
  return { problems: allProblems };
}

export function pruneRecordFields(objectName, records, fieldMap, { operation = 'insert', pruneUnknown = true, pruneNotWritable = true } = {}) {
  const isWrite = operation === 'insert' || operation === 'upsert';
  const unknownCounts = new Map();
  const notCreateableCounts = new Map();
  const notUpdateableCounts = new Map();

  const pruned = records.map((record) => {
    const out = {};
    for (const [fieldName, value] of Object.entries(record || {})) {
      if (fieldName === 'attributes') { out[fieldName] = value; continue; }
      const fieldDescribe = fieldMap.get(String(fieldName).toLowerCase());
      if (fieldDescribe) {
        if (pruneNotWritable && fieldName !== 'Id') {
          if (isWrite && fieldDescribe.createable === false) { notCreateableCounts.set(fieldName, (notCreateableCounts.get(fieldName) || 0) + 1); continue; }
          if (!isWrite && fieldDescribe.updateable === false) { notUpdateableCounts.set(fieldName, (notUpdateableCounts.get(fieldName) || 0) + 1); continue; }
        }
        out[fieldName] = value;
      } else {
        if (pruneUnknown) { unknownCounts.set(fieldName, (unknownCounts.get(fieldName) || 0) + 1); }
        else { out[fieldName] = value; }
      }
    }
    return out;
  });

  const summarize = (countMap) => Array.from(countMap.entries()).map(([name, count]) => `${name} × ${count}`).join(', ');
  if (unknownCounts.size) log.info(objectName, `🪓 Pruned unknown fields (total ${records.length} record(s)): ${summarize(unknownCounts)}`);
  if (notCreateableCounts.size && isWrite) log.info(objectName, `🪓 Pruned non-createable fields for ${operation}: ${summarize(notCreateableCounts)}`);
  if (notUpdateableCounts.size && !isWrite) log.info(objectName, `🪓 Pruned non-updateable fields for ${operation}: ${summarize(notUpdateableCounts)}`);

  return pruned;
}
```

---

### `lib/salesforce/permset.js`

Creates a Permission Set via Metadata API (with deploy fallback), upserts field-level permissions, and assigns to a user.

```javascript
// lib/salesforce/permset.js
import JSZipPkg from 'jszip';
const JSZip = JSZipPkg;

const API_VERSION = '60.0';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function sanitizePsName(name) {
  let s = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(s)) s = 'PS_' + s;
  if (s.length > 40) s = s.slice(0, 40);
  return s;
}

export async function ensurePermissionSetExists(conn, { name, label, log = console }) {
  const fullName = sanitizePsName(name);
  const read = await conn.metadata.read('PermissionSet', [fullName]);
  const ps = Array.isArray(read) ? read[0] : read;
  if (ps?.fullName) return fullName;

  const createRes = await conn.metadata.create('PermissionSet', {
    fullName, label: label || fullName, hasActivationRequired: false
  });
  const cr = Array.isArray(createRes) ? createRes[0] : createRes;
  if (cr && String(cr.success) === 'true') {
    log.info(`[Permissionset] Created via metadata.create: ${fullName}`);
    return fullName;
  }

  log.warn(`[Permissionset] metadata.create failed for ${fullName}. Falling back to deploy…`);

  const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${fullName}</members><name>PermissionSet</name></types>
  <version>${API_VERSION}</version>
</Package>`;
  const psXml = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <hasActivationRequired>false</hasActivationRequired>
  <label>${(label || fullName).replace(/&/g, '&amp;')}</label>
</PermissionSet>`;

  const zip = new JSZip();
  zip.file('package.xml', pkgXml);
  zip.file(`permissionsets/${fullName}.permissionset-meta.xml`, psXml);
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const deploy = await conn.metadata.deploy(zipBuf, { checkOnly: false, singlePackage: true });

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await conn.metadata.checkDeployStatus(deploy.id, true);
    if (st.done === 'true') {
      if (st.status !== 'Succeeded') {
        const fails = arr(st.details?.componentFailures).map(f => `${f.componentType}.${f.fullName}: ${f.problem}`).join(' | ');
        throw new Error(`[Permissionset] Deploy failed: ${fails || st.errorMessage || st.status}`);
      }
      log.info(`[Permissionset] Created via deploy: ${fullName}`);
      return fullName;
    }
  }
  throw new Error(`[Permissionset] Timeout waiting for Permission Set deploy: ${fullName}`);
}

export async function upsertFieldPermissions(conn, { permissionSetName, entries, log = console }) {
  if (!permissionSetName) throw new Error('permissionSetName is required.');
  if (!entries?.length) return;

  const psName = sanitizePsName(permissionSetName);
  const read = await conn.metadata.read('PermissionSet', [psName]);
  const ps = Array.isArray(read) ? read[0] : read;
  if (!ps?.fullName) throw new Error(`[Permissionset] Not found: ${psName}. Call ensurePermissionSetExists first.`);

  function sanitizeObjectPermissions(list = []) {
    return list.filter(op => op && typeof op.object === 'string' && op.object.trim()).map(op => ({
      object: op.object.trim(), allowCreate: !!op.allowCreate, allowDelete: !!op.allowDelete,
      allowEdit: !!op.allowEdit, allowRead: !!op.allowRead,
      modifyAllRecords: !!op.modifyAllRecords, viewAllRecords: !!op.viewAllRecords,
    }));
  }
  const base = {
    fullName: psName, label: ps.label || psName, hasActivationRequired: ps.hasActivationRequired || false,
    fieldPermissions: Array.isArray(ps.fieldPermissions) ? ps.fieldPermissions.slice() : [],
    objectPermissions: sanitizeObjectPermissions(ps.objectPermissions)
  };

  for (const e of entries) {
    const field = `${e.objectName}.${e.fieldApiName}`;
    const i = base.fieldPermissions.findIndex(fp => fp.field === field);
    const fp = { field, readable: !!e.readable, editable: !!e.editable };
    if (i === -1) base.fieldPermissions.push(fp); else base.fieldPermissions[i] = fp;
  }

  const upd = await conn.metadata.update('PermissionSet', base);
  const ur = Array.isArray(upd) ? upd[0] : upd;
  if (!ur || String(ur.success) !== 'true') {
    const msg = arr(ur?.errors).map(e => e?.message || e).join('; ') || 'Unknown error';
    throw new Error(`[Permissionset] Update failed: ${msg}`);
  }
  log.info(`[Permissionset] fieldPermissions merged on ${psName}`);
}

export async function assignPermissionSetToUser(conn, { permissionSetName, userId, maxTries = 10, retryMs = 1500, log = console }) {
  const psName = sanitizePsName(permissionSetName);
  let psId = null;
  for (let t = 0; t < maxTries && !psId; t++) {
    const found = await conn.sobject('PermissionSet').find({ Name: psName }, 'Id').limit(1);
    psId = found?.[0]?.Id || null;
    if (!psId) await sleep(retryMs);
  }
  if (!psId) throw new Error(`[Permissionset] ${psName} not visible via data API yet; try again shortly.`);

  const existing = await conn.sobject('PermissionSetAssignment')
    .find({ AssigneeId: userId, PermissionSetId: psId }, 'Id').limit(1);
  if (existing?.length) { log.info(`[Permissionset] Already assigned: ${psName} -> ${userId}`); return; }

  await conn.sobject('PermissionSetAssignment').create({ AssigneeId: userId, PermissionSetId: psId });
  log.info(`[Permissionset] Assigned: ${psName} -> ${userId}`);
}

export async function grantFieldAccessWithPermSet(conn, { permissionSetName, permissionSetLabel = permissionSetName, grants, assignToUserId = null, log = console }) {
  const psName = await ensurePermissionSetExists(conn, { name: permissionSetName, label: permissionSetLabel, log });
  await upsertFieldPermissions(conn, { permissionSetName: psName, entries: grants, log });
  if (assignToUserId) await assignPermissionSetToUser(conn, { permissionSetName: psName, userId: assignToUserId, log });
  return psName;
}
```

---

### `lib/transform/index.js`

```javascript
export { shapeRecord, assertRequiredFields } from './shape.js';
export { applyTransforms } from './transforms.js';
export { resolveConstantsDeep } from './constants.js';
export { resolveReferences, resolveRef, inferTargetObject, getByPath } from './ref-solver.js';
```

---

### `lib/transform/transforms.js`

Supported ops: `assign` (template expr), `copy` (field-to-field), `rename` (move+delete), `remove` (delete), `coalesce` (first non-empty from list), `concat` (join template parts).

```javascript
// lib/transform/transforms.js
function get(obj, dotPath) {
  return String(dotPath).split('.').reduce((current, key) => (current != null ? current[key] : undefined), obj);
}
function set(obj, dotPath, value) {
  const keys = String(dotPath).split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}
function del(obj, dotPath) {
  const keys = String(dotPath).split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null) return;
    current = current[key];
  }
  delete current[keys[keys.length - 1]];
}
function applyRecordTemplates(template, record) {
  if (typeof template !== 'string') return template;
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = get(record, path.trim());
    return value == null ? '' : String(value);
  });
}

export function applyTransforms(record, transforms = []) {
  let out = { ...record };
  for (const transform of transforms) {
    const { op } = transform || {};
    if (!op) continue;
    if (op === 'assign') {
      set(out, transform.out, applyRecordTemplates(transform.expr, out));
    } else if (op === 'copy') {
      set(out, transform.out, get(out, transform.from));
    } else if (op === 'rename') {
      const value = get(out, transform.from);
      if (value !== undefined) { set(out, transform.to, value); del(out, transform.from); }
    } else if (op === 'remove') {
      del(out, transform.field);
    } else if (op === 'coalesce') {
      const sources = transform.from || [];
      let resolved;
      for (const src of sources) {
        const v = get(out, src);
        if (v != null && v !== '') { resolved = v; break; }
      }
      if (resolved === undefined) resolved = transform.default;
      set(out, transform.out, resolved);
    } else if (op === 'concat') {
      const parts = (transform.parts || []).map((part) => applyRecordTemplates(part, out));
      set(out, transform.out, parts.join(''));
    }
  }
  return out;
}
```

---

### `lib/transform/shape.js`

Processing order: removeFields → defaults (fill missing) → fieldMap (rename).

```javascript
// lib/transform/shape.js
function get(obj, dotPath) {
  return String(dotPath).split('.').reduce((current, key) => (current != null ? current[key] : undefined), obj);
}
function set(obj, dotPath, value) {
  const keys = String(dotPath).split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}
function del(obj, dotPath) {
  const keys = String(dotPath).split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null) return;
    current = current[key];
  }
  delete current[keys[keys.length - 1]];
}

export function shapeRecord(record, config) {
  const out = { ...record };
  for (const fieldPath of config?.shape?.removeFields || []) del(out, fieldPath);
  const defaults = config?.shape?.defaults || {};
  for (const [fieldPath, defaultValue] of Object.entries(defaults)) {
    if (get(out, fieldPath) === undefined) set(out, fieldPath, defaultValue);
  }
  const fieldMap = config?.shape?.fieldMap || {};
  for (const [srcPath, destPath] of Object.entries(fieldMap)) {
    if (srcPath !== destPath && get(out, srcPath) !== undefined) {
      set(out, destPath, get(out, srcPath));
      del(out, srcPath);
    }
  }
  return out;
}

export function assertRequiredFields(record, fields = [], label = 'record') {
  for (const fieldPath of fields) {
    const value = get(record, fieldPath);
    if (value == null || value === '') {
      throw new Error(`Validation failed: '${label}' missing required field '${fieldPath}'`);
    }
  }
}
```

---

### `lib/transform/constants.js`

Resolves `${constants.<path>}` placeholders anywhere in a JSON-serializable structure.

```javascript
// lib/transform/constants.js
function get(obj, dotPath) {
  return String(dotPath).split('.').reduce((current, key) => (current != null ? current[key] : undefined), obj);
}

export function resolveConstantsDeep(config, constants = {}) {
  const serialized = JSON.stringify(config).replace(
    /\$\{constants\.([^}]+)\}/g,
    (_, path) => {
      const value = get(constants, path);
      return value == null ? '' : String(value);
    }
  );
  return JSON.parse(serialized);
}
```

---

### `lib/transform/ref-solver.js`

Resolves foreign key references. Supports template syntax (`${FieldName}`), array refKey (first non-empty), and legacy `idMaps.<Object>['key']` syntax. Configurable `onMissing`: `"error"` | `"null"` | `"skip"`.

```javascript
// lib/transform/ref-solver.js
export function inferTargetObject(field, currentObject) {
  if (field === "ParentId") return currentObject || null;
  if (field && field.endsWith("Id")) return field.slice(0, -2);
  return null;
}

export function getByPath(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

function renderTemplate(tpl, record) {
  return String(tpl).replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const val = getByPath(record, expr.trim());
    return val == null ? "" : String(val);
  });
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function parseLegacyFrom(fromStr, record) {
  const m = String(fromStr).match(/^idMaps\.([A-Za-z0-9_]+)\[['"]([^'"]+)['"]\]$/);
  if (!m) return null;
  const [, obj, keyTpl] = m;
  const key = keyTpl.includes("${") ? renderTemplate(keyTpl, record) : keyTpl;
  return { targetObject: obj, key };
}

function pickTemplate(entry) {
  return entry.refKey ?? entry.template ?? entry.keyTemplate ?? entry.compositeKeyTemplate ?? null;
}

export function resolveRef(entry, record, idMaps, currentObject) {
  if (process.env.DEBUG_REFS === "true") console.debug("[ref] entry:", JSON.stringify(entry));

  const { field, refKey, refObject, onMissing = "error", required = false, from } = entry;
  if (!field) throw new Error(`[ref] Entry missing 'field'.`);

  let targetObject = refObject || inferTargetObject(field, currentObject) || currentObject;
  let keyValue;

  if (from && typeof from === "string" && from.startsWith("idMaps.")) {
    const parsed = parseLegacyFrom(from, record);
    if (!parsed) throw new Error(`[ref] Unsupported legacy 'from' expression for field "${field}": ${from}`);
    targetObject = parsed.targetObject;
    keyValue = parsed.key;
  } else {
    const tpl = pickTemplate(entry);
    if (typeof tpl === "string") {
      keyValue = renderTemplate(tpl, record);
    } else if (Array.isArray(refKey)) {
      keyValue = firstNonEmpty(refKey.map((k) => getByPath(record, k)));
    } else if (typeof refKey === "string") {
      keyValue = getByPath(record, refKey);
    } else {
      throw new Error(`[ref] Field "${field}" must include 'refKey' (string|array) or 'refKeyTemplate'.`);
    }
  }

  const missingKey = keyValue == null || String(keyValue).trim() === "";
  if (missingKey) {
    if (required || onMissing === "error") throw new Error(`[ref] Missing key for field "${field}".`);
    if (onMissing === "null") return null;
    if (onMissing === "skip") return undefined;
  }

  if (!targetObject) throw new Error(`[ref] Cannot infer target object for field "${field}". Provide "refObject".`);

  const bucket = idMaps?.[targetObject] || {};
  const resolved = bucket[keyValue];

  if (!resolved) {
    if (required || onMissing === "error") throw new Error(`[ref] Not found: idMaps.${targetObject}["${keyValue}"] for field "${field}".`);
    if (onMissing === "null") return null;
    if (onMissing === "skip") return undefined;
  }

  return resolved;
}

export function resolveReferences(rec, references = [], idMaps = {}, currentObject = null) {
  if (!Array.isArray(references) || references.length === 0) return rec;
  for (const entry of references) {
    if (!entry || typeof entry !== "object") continue;
    const val = resolveRef(entry, rec, idMaps, currentObject);
    if (val !== undefined) rec[entry.field] = val;
  }
  return rec;
}

export default { resolveReferences, resolveRef, inferTargetObject, getByPath };
```

---

### `lib/utils/logger.js`

```javascript
// lib/utils/logger.js
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = (process.env.LOG_LEVEL || 'info').toLowerCase();
const ts = () => new Date().toISOString();
const can = (lvl) => LEVELS[CURRENT] >= LEVELS[lvl];
const line = (obj, msg) => `[${ts()}]${obj ? ` [${obj}]` : ''} ${msg}`;

export const log = {
  info:  (obj, msg) => can('info')  && console.log(line(obj, msg)),
  warn:  (obj, msg) => can('warn')  && console.warn(line(obj, msg)),
  error: (obj, msg) => can('error') && console.error(line(obj, msg)),
  debug: (obj, msg) => can('debug') && console.debug(line(obj, msg)),
  stepStart(obj) {},
  stepEnd(obj, summary='') {},
  summarizeResults(obj, records, results, keyField) {
    let ok = 0, fail = 0;
    results.forEach((r) => (r.success ? ok++ : fail++));
    console.log(line(obj, `Results: ✅ ${ok}  ❌ ${fail}`));
    if (fail) {
      results.forEach((r, i) => {
        if (!r.success) {
          const key = keyField && records[i] ? records[i][keyField] : `row#${i}`;
          const errs = (r.errors || []).map(e => e.message || e).join('; ');
          console.error(line(obj, `FAIL ${key}: ${errs}`));
        }
      });
    }
  }
};
```

---

### `lib/utils/duallogger.js`

```javascript
// lib/utils/duallogger.js
export function createDualLogger(consoleLog, fileLog) {
  return {
    info:  (tag, msg) => { consoleLog?.info?.(tag, msg);  fileLog?.(tag, msg); },
    warn:  (tag, msg) => { consoleLog?.warn?.(tag, msg);  fileLog?.(tag, msg); },
    error: (tag, msg) => { consoleLog?.error?.(tag, msg); fileLog?.(tag, msg); },
    debug: (tag, msg) => { consoleLog?.debug?.(tag, msg); fileLog?.(tag, msg); },
  };
}
```

---

### `lib/utils/runlog.js`

```javascript
// lib/utils/runlog.js
import fs from "fs";
import path from "path";

const ts = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

function line(tag, msg) { return `[${ts()}]${tag ? ` [${tag}]` : ""} ${msg}`; }

export function createRunLogSingle(baseDir = "logs") {
  const runId = `run-${stamp()}`;
  const logsDir = path.join(process.cwd(), baseDir);
  const filePath = path.join(logsDir, `${runId}.log`);
  fs.mkdirSync(logsDir, { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: "a" });

  return {
    runId,
    path: filePath,
    write(tag, msg) { stream.write(line(tag, msg) + "\n"); },
    writeJson(tag, label, obj) {
      stream.write(line(tag, `${label} >>>`) + "\n");
      stream.write(JSON.stringify(obj, null, 2) + "\n");
      stream.write(line(tag, "<<< END JSON") + "\n");
    },
    close() { try { stream.end(); } catch (_) {} },
  };
}
```

---

### `lib/utils/runcontext.js`

```javascript
// lib/utils/runcontext.js
let orgId = null;

export function setOrgId(id) {
  if (!id || typeof id !== "string") throw new Error("runContext.setOrgId: id must be a non-empty string");
  orgId = id.trim();
}
export function getOrgId() {
  if (!orgId) throw new Error("runContext.getOrgId: Org Id has not been set yet.");
  return orgId;
}
export function hasOrgId() { return Boolean(orgId); }
export function resetOrgId() { orgId = null; }
```

---

### `lib/validators/validatematchkeys.js`

Validates that `identify.matchKey` fields exist on the org (using local snapshot). If `AUTO_CREATE_MATCH_KEYS=true`, creates missing fields as Text(255) External ID via Metadata API, grants FLS via Permission Set, refreshes snapshot, then re-validates.

```javascript
// lib/validators/validatematchkeys.js
import fs from "fs";
import path from "path";
import { readJSON } from "../config/utils.js";
import { grantFieldAccessWithPermSet } from "../salesforce/permset.js";

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}
function toArray(v) { return !v ? [] : (Array.isArray(v) ? v : [v]); }
function getMatchKeys(cfg) {
  const raw = cfg?.identify?.matchKey;
  return toArray(raw).map(s => String(s).trim()).filter(Boolean);
}
function buildFieldSetFromDescribe(describeJson) {
  const set = new Set();
  for (const f of (describeJson.fields || [])) set.add(f.name);
  return set;
}
function readDescribeSnapshot({ metaDir, orgId, objectName }) {
  const filePath = path.join(metaDir, orgId, `${objectName}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Describe snapshot not found for ${objectName} at ${filePath}`);
  return { json: readJSON(filePath), filePath };
}
function labelFromApi(fieldApiName) {
  const base = fieldApiName.endsWith("__c")
    ? fieldApiName.slice(0, -3).split("__").pop()
    : fieldApiName;
  return base.replace(/_/g, " ");
}

async function createTextExternalIdField(conn, objectName, fieldApiName, log = console, opts = {}) {
  const metadata = [{
    fullName: `${objectName}.${fieldApiName}`,
    label: labelFromApi(fieldApiName),
    type: "Text", length: 255, externalId: true, unique: true, required: false
  }];

  log.info(`Creating field ${objectName}.${fieldApiName} (Text(255), External Id, Unique)…`);
  const res = await conn.metadata.create("CustomField", metadata);
  const results = Array.isArray(res) ? res : [res];
  const r = results[0];
  if (!r) throw new Error(`No result from metadata.create for ${objectName}.${fieldApiName}`);
  if (String(r.success) !== "true") {
    const probs = toArray(r?.errors).map(e => (e?.message || e)).join("; ");
    throw new Error(`Failed creating ${objectName}.${fieldApiName}: ${probs || "Unknown error"}`);
  }
  log.info(`Field created: ${objectName}.${fieldApiName}`);

  const {
    permissionSetName = 'CloudSeeder_Field_Access',
    permissionSetLabel = 'CloudSeeder Field Access',
    assignToCurrentUser = true,
    assignToUserId = null
  } = opts;
  const userId = assignToUserId || (assignToCurrentUser ? (await conn.identity()).user_id : null);
  await grantFieldAccessWithPermSet(conn, {
    permissionSetName, permissionSetLabel,
    grants: [{ objectName, fieldApiName, readable: true, editable: true }],
    assignToUserId: userId, log
  });
  log.info(`FLS granted via Permission Set '${permissionSetName}' for ${objectName}.${fieldApiName}`);
}

async function refreshSingleSnapshot(conn, { metaDir, orgId, objectName }, log) {
  log.info(`Refreshing local snapshot for ${objectName}…`);
  const d = await conn.sobject(objectName).describe();
  const targetPath = path.join(metaDir, orgId, `${objectName}.json`);
  writeJSON(targetPath, d);
  log.info(`Snapshot updated: ${targetPath}`);
}

export async function validateMatchKeysFromSnapshots({ steps, metaDir, orgId, loadStepConfig, envName, cwd, logFn, consoleLog, conn }) {
  const L = {
    info:  (m) => { consoleLog?.info?.("VALIDATOR", m);  logFn?.("VALIDATOR", m); },
    warn:  (m) => { consoleLog?.warn?.("VALIDATOR", m);  logFn?.("VALIDATOR", m); },
    error: (m) => { consoleLog?.error?.("VALIDATOR", m); logFn?.("VALIDATOR", m); },
    json:  (label, obj) => {
      if (logFn) { logFn("VALIDATOR", `${label} >>>`); logFn("VALIDATOR", JSON.stringify(obj, null, 2)); logFn("VALIDATOR", "<<< END JSON"); }
    }
  };

  const AUTO_CREATE = String(process.env.AUTO_CREATE_MATCH_KEYS || "").toLowerCase() === "true";
  if (AUTO_CREATE && !conn) L.warn("AUTO_CREATE_MATCH_KEYS=true but no connection provided — will validate only.");
  L.info("Validating identify.matchKey fields against snapshot…");

  const snapshotCache = new Map();
  const warnings = [];
  let missing = [];

  for (const step of steps) {
    const objectName = String(step.object || "").trim();
    if (!objectName) continue;
    let mappingCfg;
    try {
      mappingCfg = loadStepConfig(step, { envName, cwd, cache: true });
    } catch (e) {
      const msg = `Failed to load mapping for ${objectName}: ${e?.message || e}`;
      L.error(msg);
      missing.push({ object: objectName, key: "<mapping load failed>", reason: msg });
      continue;
    }
    const keys = getMatchKeys(mappingCfg);
    if (!keys.length) { warnings.push({ object: objectName, message: "No identify.matchKey defined." }); continue; }

    let snap = snapshotCache.get(objectName);
    if (!snap) {
      try {
        const { json, filePath } = readDescribeSnapshot({ metaDir, orgId, objectName });
        snap = { json, filePath, fieldSet: buildFieldSetFromDescribe(json) };
        snapshotCache.set(objectName, snap);
      } catch (e) {
        const msg = `Snapshot read failed for ${objectName}: ${e?.message || e}`;
        L.error(msg);
        missing.push({ object: objectName, key: "<no snapshot>", reason: msg });
        continue;
      }
    }
    for (const key of keys) {
      if (!snap.fieldSet.has(key)) missing.push({ object: objectName, key, reason: "not in snapshot" });
    }
  }

  for (const w of warnings) L.warn(`${w.object}: ${w.message}`);

  if (AUTO_CREATE && conn && missing.length) {
    const byObject = new Map();
    for (const m of missing) {
      if (!byObject.has(m.object)) byObject.set(m.object, []);
      if (m.key && m.key !== "<mapping load failed>" && m.key !== "<no snapshot>") {
        byObject.get(m.object).push(m.key);
      }
    }
    L.info(`AUTO_CREATE_MATCH_KEYS=true — attempting to create ${missing.length} missing key(s)…`);
    L.json("Missing (pre-create)", missing);

    for (const [objectName, keys] of byObject.entries()) {
      const uniqueKeys = [...new Set(keys)];
      for (const key of uniqueKeys) {
        try { await createTextExternalIdField(conn, objectName, key, L); }
        catch (e) { L.error(`Creation failed for ${objectName}.${key}: ${e?.message || e}`); }
      }
      try {
        await refreshSingleSnapshot(conn, { metaDir, orgId, objectName }, L);
        const fresh = readDescribeSnapshot({ metaDir, orgId, objectName });
        snapshotCache.set(objectName, { json: fresh.json, filePath: fresh.filePath, fieldSet: buildFieldSetFromDescribe(fresh.json) });
      } catch (e) { L.error(`Snapshot refresh failed for ${objectName}: ${e?.message || e}`); }
    }

    const remaining = [];
    for (const m of missing) {
      if (!m.key || m.key === "<mapping load failed>" || m.key === "<no snapshot>") { remaining.push(m); continue; }
      const snap = snapshotCache.get(m.object);
      if (!snap || !snap.fieldSet.has(m.key)) remaining.push(m);
    }
    missing = remaining;
  }

  if (missing.length) {
    L.json("MATCH KEY VALIDATION ERRORS", missing);
    for (const e of missing) L.error(`${e.object}: '${e.key}' missing`);
    const err = new Error(AUTO_CREATE
      ? "Match key validation failed after auto-create — see run log for details."
      : "Match key validation failed — see run log for details."
    );
    err.details = missing;
    throw err;
  }

  L.info("All match keys exist ✅");
}
```

---

### `services/generators.js`

Custom generators for complex object hierarchies. Each generator receives the full raw data object and cumulative idMaps; returns an array of records ready for the loader pipeline.

```javascript
// services/generators.js
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function requiredId(idMapBucket, key, context) {
  const out = idMapBucket?.[key];
  if (!out) throw new Error(`[generators] Missing ID for key='${key}' in ${context}.`);
  return out;
}

export const generators = {
  // Expert↔Location junctions: resolves expert + location seed IDs to SFDC IDs
  generateExpertLocationJunctions: (data, idMaps) => {
    const experts = data["BKAI__Expert__c"] || [];
    const locIdMap = idMaps["BKAI__Location__c"] || Object.create(null);
    const expIdMap = idMaps["BKAI__Expert__c"] || Object.create(null);
    return experts.map((e) => ({
      BKAI__Expert__c: requiredId(expIdMap, e.Name, "idMaps['BKAI__Expert__c']"),
      BKAI__Location__c: requiredId(locIdMap, e.BKAI__Location__c, "idMaps['BKAI__Location__c']")
    }));
  },

  // Clones shift pattern templates for each Location (cross-product)
  generateShiftPatternsPerLocation: (data, idMaps) => {
    const templates = data["BKAI__Shift_Pattern__c"] || [];
    const locations = data["BKAI__Location__c"] || [];
    const locIdMap = idMaps["BKAI__Location__c"] || Object.create(null);
    const out = [];
    for (const loc of locations) {
      const sfLocId = requiredId(locIdMap, loc.Id, "idMaps['BKAI__Location__c']");
      for (const tpl of templates) {
        out.push({ ...tpl, BKAI__Location__c: sfLocId });
      }
    }
    return out;
  },

  // Generates child Locations with parent hierarchy resolved
  generateChildLocationsWithHierarchy: (data, idMaps) => {
    const all = data["BKAI__Location__c"] || [];
    const locIdMap = idMaps["BKAI__Location__c"] || Object.create(null);
    return all
      .filter((loc) => !!loc.BKAI__Parent_Location__c)
      .map((loc) => ({
        ...loc,
        BKAI__Parent_Location__c: requiredId(locIdMap, loc.BKAI__Parent_Location__c, "idMaps['BKAI__Location__c']")
      }));
  }
};
```

---

### `config/constants.json`

```json
{
  "oppty": {
    "defaultStageName": "Prospecting",
    "defaultCloseDate": "2025-09-30"
  }
}
```

---

### `config/pipeline.json`

```json
{
  "dryRun": false,
  "steps": [
    {
      "object": "Account",
      "dataFile": "./config/sales/data/seed.json",
      "dataKey": "Account",
      "mode": "direct",
      "configFile": "./config/sales/mappings/Account.json",
      "dependsOn": []
    },
    {
      "object": "Contact",
      "dataFile": "./config/sales/data/seed.json",
      "dataKey": "Contact",
      "mode": "direct",
      "configFile": "./config/sales/mappings/Contact.json",
      "dependsOn": ["Account"]
    },
    {
      "object": "Opportunity",
      "dataFile": "./config/sales/data/seed.json",
      "dataKey": "Opportunity",
      "mode": "direct",
      "configFile": "./config/sales/mappings/Opportunity.json",
      "dependsOn": ["Account", "Contact"]
    }
  ]
}
```

---

### `config/sales/mappings/Account.json`

```json
{
  "identify": { "matchKey": "External_Id__c" },
  "shape": {
    "fieldMap": {},
    "defaults": { "Type": "Customer" },
    "removeFields": []
  },
  "transform": { "pre": [], "post": [] },
  "references": [],
  "validate": {
    "requiredFields": ["Name", "External_Id__c"],
    "uniqueBy": ["External_Id__c"]
  },
  "strategy": {
    "operation": "upsert",
    "externalIdField": "External_Id__c",
    "api": "bulk",
    "batchSize": 200
  }
}
```

---

### `config/sales/mappings/Contact.json`

```json
{
  "identify": { "matchKey": "External_Id__c" },
  "shape": { "fieldMap": {}, "defaults": {}, "removeFields": [] },
  "transform": {
    "pre": [],
    "post": [{ "op": "remove", "field": "AccountExternalId" }]
  },
  "references": [
    {
      "field": "AccountId",
      "refObject": "Account",
      "refKey": "${AccountExternalId}",
      "required": true
    }
  ],
  "validate": {
    "requiredFields": ["External_Id__c", "LastName", "AccountId"],
    "uniqueBy": ["External_Id__c"]
  },
  "strategy": {
    "operation": "upsert",
    "externalIdField": "External_Id__c",
    "api": "rest",
    "batchSize": 200
  }
}
```

---

### `config/sales/mappings/Opportunity.json`

```json
{
  "identify": { "matchKey": "External_Id__c" },
  "shape": {
    "fieldMap": {},
    "defaults": {
      "StageName": "${constants.oppty.defaultStageName}",
      "CloseDate": "${constants.oppty.defaultCloseDate}"
    },
    "removeFields": []
  },
  "transform": {
    "pre": [],
    "post": [{ "op": "remove", "field": "AccountExternalId" }]
  },
  "references": [
    {
      "field": "AccountId",
      "refObject": "Account",
      "refKey": "${AccountExternalId}",
      "required": true
    }
  ],
  "validate": {
    "requiredFields": ["External_Id__c", "Name", "StageName", "CloseDate", "AccountId"],
    "uniqueBy": ["External_Id__c"]
  },
  "strategy": {
    "operation": "upsert",
    "externalIdField": "External_Id__c",
    "api": "bulk",
    "batchSize": 200
  }
}
```

---

### `config/sales/data/seed.json`

Sample data: 20 Accounts, 20 Contacts (linked by `AccountExternalId`), 20 Opportunities (linked by `AccountExternalId`).

```json
{
  "Account": [
    { "External_Id__c": "acct-001", "Name": "Acme Corp" },
    { "External_Id__c": "acct-002", "Name": "Global Dynamics Inc" },
    { "External_Id__c": "acct-003", "Name": "Horizon Technologies" },
    { "External_Id__c": "acct-004", "Name": "Synergy Solutions" },
    { "External_Id__c": "acct-005", "Name": "Pinnacle Group" },
    { "External_Id__c": "acct-006", "Name": "Quantum Systems" },
    { "External_Id__c": "acct-007", "Name": "Apex Innovations" },
    { "External_Id__c": "acct-008", "Name": "Summit Ventures" },
    { "External_Id__c": "acct-009", "Name": "Transcend Media" },
    { "External_Id__c": "acct-010", "Name": "Velocity Labs" },
    { "External_Id__c": "acct-011", "Name": "Stellar Forge" },
    { "External_Id__c": "acct-012", "Name": "Blue Sky Aviation" },
    { "External_Id__c": "acct-013", "Name": "First Capital Bank" },
    { "External_Id__c": "acct-014", "Name": "EcoGreen Energy" },
    { "External_Id__c": "acct-015", "Name": "MediCore Health" },
    { "External_Id__c": "acct-016", "Name": "Terra Nova Mining" },
    { "External_Id__c": "acct-017", "Name": "Digital Reef" },
    { "External_Id__c": "acct-018", "Name": "Precision Engineering" },
    { "External_Id__c": "acct-019", "Name": "Gryphon Security" },
    { "External_Id__c": "acct-020", "Name": "Aurora Creative" }
  ],
  "Contact": [
    { "External_Id__c": "cont-001", "FirstName": "Sam",       "LastName": "Lee",       "Email": "sam.lee@acme.com",                    "AccountExternalId": "acct-001" },
    { "External_Id__c": "cont-002", "FirstName": "Maria",     "LastName": "Garcia",    "Email": "maria.garcia@globaldynamics.com",      "AccountExternalId": "acct-002" },
    { "External_Id__c": "cont-003", "FirstName": "David",     "LastName": "Chen",      "Email": "david.chen@horizontech.net",           "AccountExternalId": "acct-003" },
    { "External_Id__c": "cont-004", "FirstName": "Jessica",   "LastName": "Scott",     "Email": "jessica.scott@synergysol.com",         "AccountExternalId": "acct-004" },
    { "External_Id__c": "cont-005", "FirstName": "Ethan",     "LastName": "Black",     "Email": "ethan.black@pinnaclegroup.co",         "AccountExternalId": "acct-005" },
    { "External_Id__c": "cont-006", "FirstName": "Chloe",     "LastName": "Davis",     "Email": "chloe.davis@quantumsys.com",           "AccountExternalId": "acct-006" },
    { "External_Id__c": "cont-007", "FirstName": "Liam",      "LastName": "O'Connell", "Email": "liam.o.connell@apexinnov.com",         "AccountExternalId": "acct-007" },
    { "External_Id__c": "cont-008", "FirstName": "Sophia",    "LastName": "Wang",      "Email": "sophia.wang@summitventures.net",       "AccountExternalId": "acct-008" },
    { "External_Id__c": "cont-009", "FirstName": "Noah",      "LastName": "Patel",     "Email": "noah.patel@transcendmedia.org",        "AccountExternalId": "acct-009" },
    { "External_Id__c": "cont-010", "FirstName": "Olivia",    "LastName": "Rodriguez", "Email": "olivia.rodriguez@velocitylabs.io",     "AccountExternalId": "acct-010" },
    { "External_Id__c": "cont-011", "FirstName": "James",     "LastName": "Wilson",    "Email": "james.wilson@stellarforge.com",        "AccountExternalId": "acct-011" },
    { "External_Id__c": "cont-012", "FirstName": "Emily",     "LastName": "Clark",     "Email": "emily.clark@bluesky.aero",             "AccountExternalId": "acct-012" },
    { "External_Id__c": "cont-013", "FirstName": "Ben",       "LastName": "Harris",    "Email": "ben.harris@firstcapital.com",          "AccountExternalId": "acct-013" },
    { "External_Id__c": "cont-014", "FirstName": "Mia",       "LastName": "Turner",    "Email": "mia.turner@ecogreen.org",              "AccountExternalId": "acct-014" },
    { "External_Id__c": "cont-015", "FirstName": "Lucas",     "LastName": "Adams",     "Email": "lucas.adams@medicore.com",             "AccountExternalId": "acct-015" },
    { "External_Id__c": "cont-016", "FirstName": "Isabella",  "LastName": "King",      "Email": "isabella.king@terranova.com",          "AccountExternalId": "acct-016" },
    { "External_Id__c": "cont-017", "FirstName": "Henry",     "LastName": "Baker",     "Email": "henry.baker@digitalreef.net",          "AccountExternalId": "acct-017" },
    { "External_Id__c": "cont-018", "FirstName": "Amelia",    "LastName": "Hall",      "Email": "amelia.hall@precisioneng.com",         "AccountExternalId": "acct-018" },
    { "External_Id__c": "cont-019", "FirstName": "Jacob",     "LastName": "Young",     "Email": "jacob.young@gryphonsec.com",           "AccountExternalId": "acct-019" },
    { "External_Id__c": "cont-020", "FirstName": "Charlotte", "LastName": "Lopez",     "Email": "charlotte.lopez@auroracreative.biz",   "AccountExternalId": "acct-020" }
  ],
  "Opportunity": [
    { "External_Id__c": "opp-001", "Name": "Acme – Starter Deal",              "StageName": "Qualification",       "CloseDate": "2025-10-15", "Amount": 15000,  "AccountExternalId": "acct-001" },
    { "External_Id__c": "opp-002", "Name": "Global – Expansion Project",       "StageName": "Perception Analysis", "CloseDate": "2025-11-20", "Amount": 75000,  "AccountExternalId": "acct-002" },
    { "External_Id__c": "opp-003", "Name": "Horizon – New License",            "StageName": "Value Proposition",   "CloseDate": "2025-12-01", "Amount": 45000,  "AccountExternalId": "acct-003" },
    { "External_Id__c": "opp-004", "Name": "Synergy – Q4 Consulting",          "StageName": "Proposal/Price Quote","CloseDate": "2025-12-30", "Amount": 90000,  "AccountExternalId": "acct-004" },
    { "External_Id__c": "opp-005", "Name": "Pinnacle – Annual Contract",       "StageName": "Negotiation/Review",  "CloseDate": "2025-11-05", "Amount": 120000, "AccountExternalId": "acct-005" },
    { "External_Id__c": "opp-006", "Name": "Quantum – System Upgrade",         "StageName": "Closed Won",          "CloseDate": "2025-09-15", "Amount": 60000,  "AccountExternalId": "acct-006" },
    { "External_Id__c": "opp-007", "Name": "Apex – R&D Partnership",           "StageName": "Qualification",       "CloseDate": "2026-01-10", "Amount": 200000, "AccountExternalId": "acct-007" },
    { "External_Id__c": "opp-008", "Name": "Summit – Media Buy",               "StageName": "Perception Analysis", "CloseDate": "2025-10-25", "Amount": 35000,  "AccountExternalId": "acct-008" },
    { "External_Id__c": "opp-009", "Name": "Transcend – Platform Integration", "StageName": "Value Proposition",   "CloseDate": "2026-02-01", "Amount": 150000, "AccountExternalId": "acct-009" },
    { "External_Id__c": "opp-010", "Name": "Velocity – Hardware Order",        "StageName": "Closed Lost",         "CloseDate": "2025-09-01", "Amount": 25000,  "AccountExternalId": "acct-010" },
    { "External_Id__c": "opp-011", "Name": "Stellar – New Product Launch",     "StageName": "Proposal/Price Quote","CloseDate": "2025-12-15", "Amount": 180000, "AccountExternalId": "acct-011" },
    { "External_Id__c": "opp-012", "Name": "Blue Sky – Fleet Management",      "StageName": "Negotiation/Review",  "CloseDate": "2025-11-28", "Amount": 300000, "AccountExternalId": "acct-012" },
    { "External_Id__c": "opp-013", "Name": "First Capital – ATM Contract",     "StageName": "Closed Won",          "CloseDate": "2025-10-05", "Amount": 95000,  "AccountExternalId": "acct-013" },
    { "External_Id__c": "opp-014", "Name": "EcoGreen – Solar Installation",    "StageName": "Qualification",       "CloseDate": "2026-03-01", "Amount": 450000, "AccountExternalId": "acct-014" },
    { "External_Id__c": "opp-015", "Name": "MediCore – Software Implementation","StageName": "Perception Analysis","CloseDate": "2025-12-10", "Amount": 110000, "AccountExternalId": "acct-015" },
    { "External_Id__c": "opp-016", "Name": "Terra Nova – Equipment Lease",     "StageName": "Value Proposition",   "CloseDate": "2026-01-20", "Amount": 85000,  "AccountExternalId": "acct-016" },
    { "External_Id__c": "opp-017", "Name": "Digital Reef – Data Storage",      "StageName": "Proposal/Price Quote","CloseDate": "2025-11-15", "Amount": 55000,  "AccountExternalId": "acct-017" },
    { "External_Id__c": "opp-018", "Name": "Precision – New Factory Line",     "StageName": "Negotiation/Review",  "CloseDate": "2026-02-15", "Amount": 250000, "AccountExternalId": "acct-018" },
    { "External_Id__c": "opp-019", "Name": "Gryphon – Security Services",      "StageName": "Closed Won",          "CloseDate": "2025-10-20", "Amount": 70000,  "AccountExternalId": "acct-019" },
    { "External_Id__c": "opp-020", "Name": "Aurora – Video Production",        "StageName": "Qualification",       "CloseDate": "2026-01-05", "Amount": 40000,  "AccountExternalId": "acct-020" }
  ]
}
```

---

## Key Data Flow Summary

```
.env
 └─ loadEnvConfig()
      └─ runPipeline(conn, cfg, {cwd, L})
           ├─ loadConstants()         → constants.json (+ env overlay)
           ├─ loadPipeline()          → pipeline.json (+ env overlay)
           ├─ snapshotOrgMetadata()   → meta-data/<orgId>/<Object>.json
           ├─ topoSortSteps()         → dependency-ordered steps
           ├─ validateMatchKeysFromSnapshots() → auto-create missing External IDs
           └─ for each step:
                ├─ loadStepConfig()   → 4-level merged mapping config
                ├─ loadDataFile()     → seed.json (cached)
                ├─ applyFilter()      → subset records
                ├─ runGenerator()     → (if mode=generate) custom records
                └─ insertAndMap()
                     ├─ resolveConstantsDeep()    → ${constants.*}
                     ├─ applyTransforms(pre)       → assign/copy/rename/remove/coalesce/concat
                     ├─ shapeRecord()              → removeFields, defaults, fieldMap
                     ├─ resolveReferences()        → lookup idMaps → set FK fields
                     ├─ applyTransforms(post)      → cleanup helper fields
                     ├─ pruneRecordFields()        → drop unknown/non-writable fields
                     ├─ validateBatch()            → field-level metadata check
                     ├─ assertRequiredFields()     → required fields check
                     ├─ commit()                   → REST | Composite | Bulk API 2.0
                     └─ returns idMap[matchKeyValue] = salesforceId
```
