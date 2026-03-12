# Improvement Recommendations — CloudSeeder

**Review Date:** 2026-03-12
**Source:** [improvementplan_20260312_0156.md](improvementplan_20260312_0156.md)

---

## Summary Table

| ID | Recommendation | Addresses | Effort | Priority | Status |
|---|---|---|---|---|---|
| REC-001 | Decompile and restore minified source files | ARCH-001 | Medium | P1 | Open |
| REC-002 | Extract pipeline orchestrator from entry point | ARCH-002 | Medium | P1 | Open |
| REC-003 | Fix `commitComposite` return shape | ARCH-004 | Small | P1 | Open |
| REC-004 | Fix `LOG_PRUNE` `ReferenceError` | ARCH-003 | Small | P1 | Open |
| REC-005 | Create centralized environment config module | ARCH-006, ARCH-010 | Small | P1 | Open |
| REC-006 | Unify JSON parser across config layer | ARCH-008 | Small | P2 | Open |
| REC-007 | Create a unified dual-logger | ARCH-014 | Small | P2 | Open |
| REC-008 | Consolidate `deepMerge` into single shared implementation | ARCH-007 | Small | P2 | Open |
| REC-009 | Add retry wrapper for external API calls | ARCH-011 | Medium | P2 | Open |
| REC-010 | Move `dotenv.config()` to entry point | ARCH-009 | Small | P2 | Open |
| REC-011 | Add configurable metadata snapshot concurrency | ARCH-013 | Small | P3 | Open |
| REC-012 | Make `validateBatch` throw on invalid fields | ARCH-016 | Small | P3 | Open |
| REC-013 | Replace `expr` `new Function` with safe evaluator | ARCH-005 | Medium | P3 | Open |

---

## Detailed Recommendations

---

#### REC-001: Decompile and Restore Minified Source Files

- **Addresses:** [ARCH-001](architecture-findings.md#arch-001-minified-source-files-in-repository)
- **Effort:** Medium (1–3 days)
- **Priority:** P1
- **Status:** Open
- **Approach:**
  1. Use a JS decompiler (`prettier` + manual cleanup, or `deobfuscate-js`) to expand `lib/metadata.min.js` and `lib/utils.min.js` into readable source.
  2. Add JSDoc comments to each exported function.
  3. Rename single-character variables to descriptive names.
  4. Verify behavior is unchanged by running the full pipeline against a scratch org before and after.
  5. Delete the `.min.js` files and update all import statements.
- **Before:**
```js
// lib/metadata.min.js (actual minified)
export async function snapshotOrgMetadata(e,{objectNames:t,metaDir:r,...
```
- **After:**
```js
// lib/metadata.js
/**
 * Fetch and cache Salesforce describe metadata for a list of objects.
 * @param {jsforce.Connection} conn
 * @param {object} opts
 * @param {string[]} opts.objectNames - API names to snapshot
 * @param {string}   opts.metaDir    - Local cache directory
 * @param {boolean}  [opts.forceRefresh=false]
 * @param {number}   [opts.concurrency=2]
 */
export async function snapshotOrgMetadata(conn, { objectNames, metaDir, forceRefresh = false, concurrency = 2 }) {
  // readable implementation
}
```
- **Risk:** Behavioral difference if the decompiler misreads compressed logic. Mitigate by running a full pipeline integration test before and after.
- **Verification:** `npm start` with `DRY_RUN=true` and live against a scratch org; output must be identical before and after the swap.

---

#### REC-002: Extract Pipeline Orchestrator from Entry Point

- **Addresses:** [ARCH-002](architecture-findings.md#arch-002-god-file--scriptsrunloadjs)
- **Effort:** Medium (1–3 days)
- **Priority:** P1
- **Status:** Open
- **Approach:**
  1. Create `lib/pipeline/orchestrator.js` with `runPipeline(conn, pipelineCfg, options)` containing the step execution loop.
  2. Move `topoSortSteps()` to `lib/pipeline/toposort.js`.
  3. Move generator dispatch to `lib/pipeline/generators.js`.
  4. Move `loadDataFile()` and its cache to `lib/pipeline/dataloader.js`.
  5. Leave `scripts/runLoad.js` responsible only for: reading env, calling auth, loading config, calling `runPipeline`, and top-level error handling.
- **Before:**
```js
// scripts/runLoad.js
async function main() {
  runLog = createRunLogSingle("logs");
  // auth ... config ... snapshot ... toposort ... validate ... step loop
  // 250+ lines of mixed concerns
}
```
- **After:**
```js
// scripts/runLoad.js
async function main() {
  const runLog  = createRunLogSingle("logs");
  const logger  = createDualLogger(log, runLog);
  const conn    = await getConnection();
  const config  = await loadRunConfig({ envName: ENV_NAME });
  await runPipeline(conn, config, { logger, dryRun: DRY_RUN });
  runLog.close();
}
```
- **Risk:** Low — pure refactor with no behavior change. Each extracted function must be verified independently.
- **Verification:** Full pipeline run after each extraction step. Log output must be identical. All import paths must resolve.

---

#### REC-003: Fix `commitComposite` Return Shape

- **Addresses:** [ARCH-004](architecture-findings.md#arch-004-commitcomposite-returns-a-different-shape)
- **Effort:** Small (< 1 day)
- **Priority:** P1
- **Status:** Open
- **Approach:**
  Update `commitComposite` to return the same normalized shape as `commitREST` and `commitBulk`: `{ operation, created, updated, failures, processedRecords }`.
- **Before:**
```js
async function commitComposite(conn, objectName, batch, strategy) {
  const results = [];
  for (const rec of batch) {
    // per-record REST calls
    results.push(res);
  }
  return results; // raw array — breaks caller
}
```
- **After:**
```js
async function commitComposite(conn, objectName, batch, strategy) {
  const created = [], updated = [], failures = [];
  for (let i = 0; i < batch.length; i++) {
    const rec = batch[i];
    try {
      const res = strategy.operation === 'upsert'
        ? await conn.sobject(objectName).upsert(rec, strategy.externalIdField)
        : await conn.sobject(objectName).insert(rec);
      const r = Array.isArray(res) ? res[0] : res;
      if (r?.success) {
        const entry = { index: i, key: rec[strategy.externalIdField] ?? rec.Id ?? `row#${i}`, id: r.id };
        r.created ? created.push(entry) : updated.push(entry);
      } else {
        failures.push({ index: i, key: rec[strategy.externalIdField] ?? `row#${i}`, messages: [r?.errors?.[0]?.message || 'Unknown'] });
      }
    } catch (e) {
      failures.push({ index: i, key: `row#${i}`, messages: [e.message] });
    }
  }
  return { operation: strategy.operation, created, updated, failures, processedRecords: [] };
}
```
- **Risk:** Low — this is a correctness fix. No other callers are affected.
- **Verification:** Set `"api": "composite"` in a mapping config and run the pipeline. Confirm no `TypeError` and correct idMap entries are created.

---

#### REC-004: Fix `LOG_PRUNE` `ReferenceError`

- **Addresses:** [ARCH-003](architecture-findings.md#arch-003-latent-referenceerror--log_prunetrue-code-path)
- **Effort:** Small (< 1 day)
- **Priority:** P1
- **Status:** Open
- **Approach:**
  Replace `work[i]` with `transformedRecord[i]` (the variable that holds pre-prune records) in `lib/loader.js:121`.
- **Before:**
```js
pruned.slice(0,2).map((r,i) => ({ rec: i+1, removed: diff(work[i], r) }))
```
- **After:**
```js
pruned.slice(0,2).map((r,i) => ({ rec: i+1, removed: diff(transformedRecord[i], r) }))
```
- **Risk:** None — clear bug fix. The variable `work` does not exist in scope; `transformedRecord` is the correct reference.
- **Verification:** Run with `LOG_PRUNE=true`. Confirm pruning diff is logged without any `ReferenceError`.

---

#### REC-005: Create a Centralized Environment Config Module

- **Addresses:** [ARCH-006](architecture-findings.md#arch-006-scattered-environment-variable-access), [ARCH-010](architecture-findings.md#arch-010-no-pre-flight-credential-validation)
- **Effort:** Small (< 1 day)
- **Priority:** P1
- **Status:** Open
- **Approach:**
  1. Create `lib/config/env.js` that reads all env vars once, validates required ones, and exports a typed config object.
  2. Update all modules to import from this file instead of reading `process.env` directly.
  3. Move `dotenv.config()` call from `lib/auth.js` to the top of `scripts/runLoad.js` (before any env-reading imports).
- **Before:**
```js
// scattered across 8 files
// lib/auth.js
dotenv.config();
const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL });
await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);

// lib/validators/validatematchkeys.js
const AUTO_CREATE = String(process.env.AUTO_CREATE_MATCH_KEYS || "").toLowerCase() === "true";
```
- **After:**
```js
// lib/config/env.js
export function loadEnvConfig() {
  const required = ['SF_LOGIN_URL', 'SF_USERNAME', 'SF_PASSWORD'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

  return {
    salesforce: {
      loginUrl:  process.env.SF_LOGIN_URL,
      username:  process.env.SF_USERNAME,
      password:  process.env.SF_PASSWORD,
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
    }
  };
}
```
- **Risk:** Low. The only behavioral change is that missing credentials fail fast at startup with a clear message rather than at login time.
- **Verification:** Remove `SF_USERNAME` from `.env`; confirm startup error names the missing variable. Run full pipeline with all vars set; confirm behavior is unchanged.

---

#### REC-006: Unify JSON Parser Across Config Layer

- **Addresses:** [ARCH-008](architecture-findings.md#arch-008-mixed-json-parsers-across-config-layer)
- **Effort:** Small (< 1 day)
- **Priority:** P2
- **Status:** Open
- **Approach:**
  1. Update `lib/config/step-config.js:readJson()` to use JSON5 instead of `JSON.parse`.
  2. Update `lib/validators/validatematchkeys.js:readJSON()` to use JSON5.
  3. Eliminate the private `readJSON` in `validatematchkeys.js` and reuse the shared one from `lib/config/utils.js`.
- **Before:**
```js
// lib/config/step-config.js
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw); // no JSON5, no BOM strip
}
```
- **After:**
```js
// lib/config/step-config.js
import { readJSON } from './utils.js'; // JSON5-aware, BOM-stripping
```
- **Risk:** Negligible. JSON5 is a strict superset of JSON — all valid JSON files parse identically. Only new behavior is that JSON5 comments and trailing commas now work in mapping files.
- **Verification:** Parse an existing mapping file with a trailing comma added; confirm no error. Run full pipeline; confirm behavior unchanged.

---

#### REC-007: Create a Unified Dual-Logger

- **Addresses:** [ARCH-014](architecture-findings.md#arch-014-dual-logging-pattern-requires-manual-sync)
- **Effort:** Small (< 1 day)
- **Priority:** P2
- **Status:** Open
- **Approach:**
  Create `lib/utils/duallogger.js` that wraps both `log` and `runLog` and routes a single call to both. Replace all manual dual-write pairs in `scripts/runLoad.js`.
- **Before:**
```js
// repeated throughout main()
log.info("System", "Authenticated to Salesforce ✅");
fileLog("System", "Authenticated to Salesforce ✅");
```
- **After:**
```js
// lib/utils/duallogger.js
export function createDualLogger(consoleLog, runLog) {
  const write = (level, tag, msg) => {
    consoleLog[level]?.(tag, msg);
    runLog.write(tag, msg);
  };
  return {
    info:  (tag, msg) => write('info',  tag, msg),
    warn:  (tag, msg) => write('warn',  tag, msg),
    error: (tag, msg) => write('error', tag, msg),
    debug: (tag, msg) => write('debug', tag, msg),
  };
}

// scripts/runLoad.js
const logger = createDualLogger(log, runLog);
logger.info("System", "Authenticated to Salesforce ✅");
```
- **Risk:** None — pure wrapper addition. Existing behavior is preserved.
- **Verification:** Run full pipeline. Compare console output and run log file line-by-line; they must be identical.

---

#### REC-008: Consolidate `deepMerge` into Single Shared Implementation

- **Addresses:** [ARCH-007](architecture-findings.md#arch-007-duplicated-deepmerge-implementations)
- **Effort:** Small (< 1 day)
- **Priority:** P2
- **Status:** Open
- **Approach:**
  1. Adopt the non-mutating implementation from `lib/config/step-config.js` as canonical.
  2. Update `lib/config/utils.js:deepMerge()` to the non-mutating version.
  3. Remove the private `deepMerge` from `lib/config/step-config.js` and import from `lib/config/utils.js`.
- **Before:**
```js
// lib/config/utils.js — mutates target
export function deepMerge(target, ...sources) {
  for (const src of sources) {
    // mutates target[k] in-place
  }
  return target;
}
```
- **After:**
```js
// lib/config/utils.js — non-mutating, canonical
export function deepMerge(target, source) {
  if (!source) return structuredClone(target);
  if (Array.isArray(target) && Array.isArray(source)) return [...source];
  if (isPlainObject(target) && isPlainObject(source)) {
    const out = { ...target };
    for (const [k, v] of Object.entries(source)) {
      out[k] = deepMerge(out[k], v);
    }
    return out;
  }
  return structuredClone(source);
}
```
- **Risk:** The calling pattern in `loadPipeline`/`loadConstants` is `deepMerge({}, base, env)` — adjust variadic callers to `sources.reduce(deepMerge, {})`. Verify with pipeline + env overlay scenarios.
- **Verification:** Run with a `config/env/<env>/pipeline.json` overlay in place. Confirm env values correctly override base values without mutating the base object.

---

#### REC-009: Add Retry Wrapper for External API Calls

- **Addresses:** [ARCH-011](architecture-findings.md#arch-011-no-retry-or-backoff-on-external-api-calls)
- **Effort:** Medium (1–3 days)
- **Priority:** P2
- **Status:** Open
- **Approach:**
  1. Create `lib/utils/retry.js` with an exponential-backoff `withRetry(fn, opts)` utility.
  2. Wrap `getConnection()` in `lib/auth.js` and batch commits in `lib/sf.js`.
  3. Do NOT retry metadata creation or validation operations — those are not idempotent.
- **Before:**
```js
// lib/sf.js — single attempt, no retry
const results = await conn.bulk2.loadAndWaitForResults({ ... });
```
- **After:**
```js
// lib/utils/retry.js
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000, retryOn } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts;
      const shouldRetry = retryOn ? retryOn(err) : true;
      if (isLast || !shouldRetry) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// lib/sf.js
const results = await withRetry(
  () => conn.bulk2.loadAndWaitForResults({ ... }),
  { maxAttempts: 3, retryOn: (e) => e.code === 'ECONNRESET' || e.errorCode === 'REQUEST_LIMIT_EXCEEDED' }
);
```
- **Risk:** Retry on non-idempotent operations could cause duplicate inserts. The `retryOn` predicate must be carefully specified to retry only transient network/rate-limit errors.
- **Verification:** Simulate network failure mid-run (disable network during bulk load); verify retry fires and run eventually succeeds or fails with a clear message after max attempts.

---

#### REC-010: Move `dotenv.config()` to Entry Point

- **Addresses:** [ARCH-009](architecture-findings.md#arch-009-module-level-side-effect-in-libauthjs)
- **Effort:** Small (< 1 day)
- **Priority:** P2
- **Status:** Open
- **Approach:**
  Remove `dotenv.config()` from `lib/auth.js` and add it as the very first statement in `scripts/runLoad.js`, before all other imports.
- **Before:**
```js
// lib/auth.js:3
import dotenv from "dotenv";
dotenv.config(); // side effect on module import
```
- **After:**
```js
// scripts/runLoad.js:1
import 'dotenv/config'; // ESM-safe: loads .env before any other import resolves

import { getConnection } from "../lib/auth.js";
// ...
```
- **Risk:** Low. In ESM, static `import` declarations are hoisted — use `import 'dotenv/config'` as the first static import to guarantee `.env` is loaded before other modules read env vars.
- **Verification:** Remove `dotenv.config()` from `auth.js`; confirm credentials are still loaded from `.env` at runtime.

---

#### REC-011: Add Configurable Metadata Snapshot Concurrency

- **Addresses:** [ARCH-013](architecture-findings.md#arch-013-hard-coded-metadata-snapshot-concurrency)
- **Effort:** Small (< 1 day)
- **Priority:** P3
- **Status:** Open
- **Approach:**
  Read `META_CONCURRENCY` from env config (added in REC-005) and pass it through to `snapshotOrgMetadata`.
- **Before:**
```js
// scripts/runLoad.js:159
concurrency: 2  // hard-coded
```
- **After:**
```js
concurrency: envConfig.loader.metaConcurrency  // from env, default 2
```
- **Risk:** None. Increasing concurrency may hit Salesforce API limits; default of 2 remains safe. Users who raise it do so explicitly.
- **Verification:** Set `META_CONCURRENCY=4` in `.env`; confirm metadata snapshot phase completes faster without API errors.

---

#### REC-012: Make `validateBatch` Throw on Invalid Fields

- **Addresses:** [ARCH-016](architecture-findings.md#arch-016-validatebatch-warns-but-does-not-block)
- **Effort:** Small (< 1 day)
- **Priority:** P3
- **Status:** Open
- **Approach:**
  After restoring `lib/metadata.min.js` to readable source (REC-001), update `validateBatch` to return an error list and optionally throw if records contain unknown fields. Introduce a `strict` flag as opt-in.
- **Before:**
```js
// inferred from minified — warns silently, returns void
export function validateBatch(objectName, records, fieldMap, opts) {
  // logs warnings but returns void
}
```
- **After:**
```js
export function validateBatch(objectName, records, fieldMap, { operation, strict = false }) {
  const errors = [];
  for (const rec of records) {
    for (const field of Object.keys(rec)) {
      if (!fieldMap.has(field)) errors.push(`${objectName}.${field} not found in org describe`);
    }
  }
  if (strict && errors.length) throw new Error(`Schema validation failed:\n${errors.join('\n')}`);
  if (errors.length) log.warn(objectName, `validateBatch warnings:\n${errors.join('\n')}`);
}
```
- **Risk:** Enabling `strict: true` may break existing pipelines where fields are intentionally present but pruned. Start with warning-only mode; add `strict` as opt-in.
- **Verification:** Add a field to a mapping config that doesn't exist in the org; confirm warning fires. Set `strict: true`; confirm pipeline halts with a clear error before the API call.

---

#### REC-013: Replace `expr` Predicate `new Function` with Safe Evaluator

- **Addresses:** [ARCH-005](architecture-findings.md#arch-005-new-function-eval-equivalent-in-filter-expr-predicate)
- **Effort:** Medium (1–3 days)
- **Priority:** P3
- **Status:** Open
- **Approach:**
  Replace `new Function()` in `lib/filters.js` with a limited expression evaluator that supports only field access, comparison operators, and boolean combinators — no arbitrary code execution. Options: `filtrex` (npm), `expr-eval` (npm), or a custom micro-parser.
- **Before:**
```js
function buildExprRunner(expr) {
  const fn = new Function("rec", "ctx", `return (${expr});`); // eval-equivalent
  return (rec, ctx) => !!fn(rec, ctx);
}
```
- **After:**
```js
import { Parser } from 'expr-eval';
const parser = new Parser();
function buildExprRunner(expr) {
  const compiled = parser.parse(expr); // safe, no eval
  return (rec, ctx) => !!compiled.evaluate({ ...rec, ...ctx });
}
```
- **Risk:** Breaking change for any existing `expr` predicates that use JS syntax not supported by the evaluator. Audit all existing filter specs before switching. Provide a migration guide for any complex expressions.
- **Verification:** Audit every `expr` value in existing config files. Run each through the new evaluator in isolation. Run full pipeline with `DEBUG_FILTERS=true`; confirm filter results match pre-change behavior.
