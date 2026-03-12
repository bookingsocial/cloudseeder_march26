# CloudSeeder — Architectural Improvement Plan
**Review Date:** 2026-03-12 01:56 UTC
**Reviewer:** Senior Node.js Architect
**Codebase:** CloudSeeder v1.0.0 — Salesforce metadata-driven data loader

---

## Table of Contents

1. [Phase 1: Architecture Map](#phase-1-architecture-map)
2. [Phase 2: Problem Inventory](#phase-2-problem-inventory)
3. [Phase 3: Improvement Recommendations](#phase-3-improvement-recommendations)
4. [Phase 4: Target Architecture](#phase-4-target-architecture)
5. [Phase 5: Migration Roadmap](#phase-5-migration-roadmap)

---

## Phase 1: Architecture Map

### 1.1 Dependency Graph

```
scripts/runLoad.js
  ├── lib/auth.js
  │     └── jsforce (external)
  │     └── dotenv  (external, side-effect import)
  ├── lib/loader.js
  │     ├── lib/utils/logger.js
  │     ├── lib/utils.min.js          ← MINIFIED SOURCE
  │     ├── lib/mapping/ref-solver.js
  │     ├── lib/sf.js
  │     │     └── lib/utils/logger.js
  │     └── lib/metadata.min.js       ← MINIFIED SOURCE
  ├── lib/filters.js
  ├── lib/runcontext.js
  ├── lib/config/index.js
  │     ├── lib/config/pipeline.js
  │     │     └── lib/config/utils.js   (JSON5 + deepMerge)
  │     ├── lib/config/constants.js
  │     │     └── lib/config/utils.js
  │     └── lib/config/step-config.js  (own JSON.parse + own deepMerge)
  ├── lib/metadata.min.js
  ├── lib/validators/validatematchkeys.js
  │     ├── lib/utils/permset.js
  │     │     └── jszip (external)
  │     └── (own readJSON using JSON.parse — NOT JSON5)
  ├── lib/utils/logger.js
  ├── lib/utils/runlog.js
  └── services/generators.js
```

**No circular dependencies detected.**

**God files identified:**
- `scripts/runLoad.js` (329 lines) — handles authentication, config loading, metadata orchestration, topological sort, step execution loop, generator dispatch, idMap management, and dual-channel logging. Seven distinct responsibilities in one file.
- `lib/loader.js` (~199 lines) — constants interpolation, metadata loading, all per-record transforms (shape → pre → references → post), field pruning, schema validation, required-field assertion, uniqueness checking, batching, commit dispatch, and idMap construction. Also seven distinct responsibilities.

---

### 1.2 Data Flow Trace — One Full Pipeline Run

```
ENTRY: node scripts/runLoad.js
  │
  ├─ [SIDE EFFECT] dotenv.config() called inside lib/auth.js on import
  │
  ├─ ENV read: LOADER_ENV, DRY_RUN
  │
  ├─ lib/auth.js → getConnection()
  │     Reads: SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD (env vars, no validation)
  │     Creates: jsforce.Connection
  │     Calls:  conn.login() — no retry
  │     State:  conn returned as local variable in main()
  │
  ├─ lib/config/constants.js → loadConstants({ envName })
  │     Reads: config/constants.json (JSON5), config/env/<env>/constants.json (JSON5)
  │     State: constants stored as local variable in main()
  │
  ├─ lib/config/pipeline.js → loadPipeline({ envName })
  │     Reads: config/pipeline.json (JSON5), config/env/<env>/pipeline.json (JSON5)
  │     Note:  deepMerge MUTATES the first argument ({} — safe here, but footgun)
  │     State: pipelineCfg stored as local variable in main()
  │
  ├─ lib/metadata.min.js → snapshotOrgMetadata(conn, { objectNames, metaDir, forceRefresh, concurrency:2 })
  │     Calls:  conn.identity() to get orgId
  │     Writes: meta-data/<orgId>/<Object>.json (filesystem)
  │     State:  orgId written to lib/runcontext.js module singleton via setOrgId()
  │     Note:  concurrency hard-coded to 2 in caller (scripts/runLoad.js:159)
  │
  ├─ topoSortSteps(pipelineCfg.steps) → stepsOrdered[]
  │     Pure function, no I/O
  │
  ├─ lib/validators/validatematchkeys.js → validateMatchKeysFromSnapshots(...)
  │     Reads: meta-data/<orgId>/<Object>.json (own JSON.parse — NOT JSON5)
  │     Reads: env var AUTO_CREATE_MATCH_KEYS directly from process.env
  │     May call: conn.metadata.create(), conn.metadata.deploy(), permset.js
  │     Writes: meta-data/<orgId>/<Object>.json on refresh
  │
  └─ for each step:
      │
      ├─ lib/config/step-config.js → loadStepConfig(step, { envName, cwd, cache:true })
      │     Reads: config/base/<Object>.json (JSON.parse)
      │     Reads: config/env/<env>/<Object>.json (JSON.parse)
      │     Reads: step.configFile (JSON.parse)
      │     Merges: step.configInline
      │     State: CACHE Map at module level (process-lifetime memoization)
      │
      ├─ loadDataFile(step.dataFile)
      │     Reads: seed JSON/JSON5 file
      │     State: loadedFiles object at module level (process-lifetime memoization)
      │
      ├─ lib/filters.js → applyFilter(baseData, step.filter)
      │     Pure function (mostly — expr predicate uses new Function())
      │
      ├─ [if mode=generate] services/generators.js → generators[name](rawData, idMaps)
      │     Receives: raw full data file + all current idMaps
      │     Pure function (no I/O)
      │
      └─ lib/loader.js → insertAndMap(conn, obj, finalData, cfg, idMaps, constants)
            │
            ├─ lib/utils.min.js → resolveConstantsDeep(cfg, constants)
            ├─ lib/metadata.min.js → ensureObjectMetadataAvailable() + loadObjectDescribeFromCache()
            │     Reads: meta-data/<orgId>/<Object>.json (filesystem — per call)
            ├─ per record:
            │     resolveConstantsDeep → applyTransforms(pre) → shapeRecord → resolveReferences → applyTransforms(post)
            ├─ lib/metadata.min.js → pruneRecordFields()
            ├─ lib/metadata.min.js → validateBatch()      ← returns void, just warns
            ├─ lib/utils.min.js → assertRequiredFields()
            ├─ uniqueness Set check
            ├─ chunk into batches
            └─ lib/sf.js → commit(conn, obj, batch, strategy)
                  Routes to commitREST | commitComposite | commitBulk
                  Returns: { created, updated, failures, processedRecords }
                  NOTE: commitComposite returns raw array[] — DIFFERENT SHAPE
```

**State held and how it travels:**

| State | Where held | How passed |
|---|---|---|
| jsforce connection | `main()` local var | Passed as argument down to `loader.js`, `sf.js`, `validatematchkeys.js`, `permset.js` |
| constants | `main()` local var | Passed to `insertAndMap()` as argument |
| pipelineCfg | `main()` local var | Used locally in `main()` |
| idMaps (cross-step) | `main()` local var | Passed to `insertAndMap()` and generators; step idMap merged back in `main()` |
| orgId | `lib/runcontext.js` module singleton | Read globally via `getOrgId()` inside `metadata.min.js` |
| step config cache | `lib/config/step-config.js` module Map | Implicit — auto-used on repeated calls |
| data file cache | `main()` `loadedFiles` object | Implicit — auto-used on repeated calls |
| run log stream | `main()` `runLog` var | Captured in closure via `fileLog` helper |

---

### 1.3 Coupling & Cohesion Analysis

**Tightly coupled pairs (hard to change independently):**

| Module A | Module B | Coupling Type |
|---|---|---|
| `scripts/runLoad.js` | `lib/auth.js` | Direct import; no abstraction |
| `scripts/runLoad.js` | `lib/metadata.min.js` | Direct import of minified module |
| `scripts/runLoad.js` | `lib/validators/validatematchkeys.js` | Passes 9 constructor arguments — wide interface |
| `lib/loader.js` | `lib/metadata.min.js` | Direct import of minified module |
| `lib/validators/validatematchkeys.js` | `lib/utils/permset.js` | Hard import; no abstraction |
| `lib/validators/validatematchkeys.js` | `process.env.AUTO_CREATE_MATCH_KEYS` | Reads env directly instead of receiving as parameter |
| `services/generators.js` | BKAI domain objects | Generator names and field names are BKAI-specific |

**Low cohesion modules (doing unrelated things):**

| Module | Unrelated Concerns Mixed |
|---|---|
| `scripts/runLoad.js` | Auth + config + metadata + sorting + execution + logging |
| `lib/loader.js` | Transform pipeline + metadata I/O + Salesforce commit dispatch + idMap construction |
| `lib/validators/validatematchkeys.js` | Field validation + field creation + snapshot refresh + FLS management |

**Concern separation assessment:**

| Concern | Status |
|---|---|
| Config loading | ✅ Mostly well separated in `lib/config/` |
| Transform logic | ⚠️ Split between `lib/utils.min.js` and `lib/loader.js` |
| Salesforce I/O | ⚠️ Commit in `lib/sf.js` but metadata I/O spread across `metadata.min.js`, `validatematchkeys.js`, and `permset.js` |
| Logging | ⚠️ Two loggers (`logger.js` + `runlog.js`); dual-write pattern manually repeated everywhere |
| Error handling | ❌ Inconsistent — see §1.4 |
| Environment variable access | ❌ Scattered — accessed in `auth.js`, `runLoad.js`, `validatematchkeys.js`, `loader.js` directly |

---

### 1.4 Error Handling Audit

| Location | Error Scenario | Handling | Assessment |
|---|---|---|---|
| `main().catch()` | Any unhandled rejection | Writes to runLog, calls `process.exit(1)` — but inner `try/catch` around that block has an **empty catch `{}`** (line 326) | ❌ Silently swallows secondary errors during error handling |
| `lib/sf.js commitBulk()` | Verification query failure | `try/catch` with `console.warn` (not `log.warn`) — uses raw `console` not `lib/utils/logger.js` | ⚠️ Inconsistent logger; non-fatal correctly |
| `lib/sf.js commitComposite()` | Per-record DML failure | `try/catch` pushes `{success: false}` to results | ✅ Correct |
| `lib/loader.js` | DML failures | Logs per-record, idMap entry not created, execution continues | ✅ Correct behavior, ⚠️ uses `log.info` not `log.error` for errors |
| `lib/loader.js LOG_PRUNE path` | `work` variable not defined | `ReferenceError` thrown at runtime | ❌ Latent bug |
| `lib/validators/validatematchkeys.js` | Mapping load failure | Caught, pushed to `missing[]`, execution continues | ✅ Correct |
| `lib/validators/validatematchkeys.js` | Field creation failure | Caught, logged, execution continues to re-check | ✅ Correct |
| `lib/auth.js` | Missing credentials | jsforce throws; propagates to `main()` catch | ⚠️ No pre-flight credential validation |
| `scripts/runLoad.js` snapshotOrgMetadata | Any unavailable object | Sets `isSnapshotSuccessful=false`, throws after check | ✅ Correct |
| `lib/config/step-config.js` | configFile not found | Throws `StepConfigError` | ✅ Correct |
| `lib/utils/permset.js ensurePermissionSetExists` | Deploy timeout | Throws after 60×2s | ✅ Correct; ⚠️ not configurable |
| `lib/filters.js expr predicate` | Expression error | Caught; returns `false` (silent filter failure) | ⚠️ Silent — filter may silently exclude all records |

**Error propagation strategy: inconsistent.** Some modules throw, some return false, some log-and-continue. No unified error class hierarchy.

---

### 1.5 Configuration Architecture

| Config Type | Loader | Parser | Validation | Source of Truth |
|---|---|---|---|---|
| pipeline.json | `lib/config/pipeline.js` | JSON5 | None beyond file existence | ✅ Centralized |
| constants.json | `lib/config/constants.js` | JSON5 | None | ✅ Centralized |
| Object mappings | `lib/config/step-config.js` | **JSON.parse (not JSON5)** | None beyond file existence | ✅ Centralized |
| Env vars | Scattered across 5+ modules | `process.env` | None | ❌ No single source of truth |
| Metadata snapshots | `lib/metadata.min.js` | JSON.parse | None | ⚠️ Filesystem cache |

**Environment variable access map:**

| Variable | Read In |
|---|---|
| `SF_LOGIN_URL`, `SF_USERNAME`, `SF_PASSWORD` | `lib/auth.js` |
| `LOADER_ENV` / `NODE_ENV` | `scripts/runLoad.js`, `lib/config/pipeline.js`, `lib/config/constants.js`, `lib/config/step-config.js` |
| `DRY_RUN` | `scripts/runLoad.js` |
| `REFRESH_METADATA` | `scripts/runLoad.js` |
| `AUTO_CREATE_MATCH_KEYS` | `lib/validators/validatematchkeys.js` |
| `LOG_LEVEL` | `lib/utils/logger.js` |
| `LOG_PRUNE` | `lib/loader.js` |
| `DEBUG_REFS` | `lib/mapping/ref-solver.js` |

No central config object — env vars are accessed wherever they are needed, making it impossible to validate or document them in one place.

---

## Phase 2: Problem Inventory

---

### P-01: Minified Source Files in Repository
**Location:** `lib/metadata.min.js`, `lib/utils.min.js`
**Severity:** High
**Description:** Two core library files are stored as minified JavaScript in the repository. They contain no whitespace, no comments, and single-character identifiers. This is production-minified output shipped as source code — the inverse of best practice.
**Impact:** Cannot be read, debugged, or modified without first decompiling. Any bug in these files requires reverse engineering. Contributors cannot understand the transform or metadata logic. IDE tooling (jump to definition, refactoring, hover docs) is completely broken for these modules. The files cannot be reasoned about during code review.

---

### P-02: God File — `scripts/runLoad.js`
**Location:** `scripts/runLoad.js`
**Severity:** High
**Description:** The entry point handles at least seven distinct responsibilities: authentication, configuration loading, metadata snapshotting, topological sort, step execution loop, generator dispatch, idMap accumulation, and dual-channel logging. All of these are procedurally wired together in a single 329-line `main()` function with no internal abstractions.
**Impact:** Any change to any concern requires understanding the entire file. The function cannot be unit-tested without mocking six external modules. Adding a new lifecycle phase (e.g., pre-run hooks) requires modifying the already-complex `main()`. Cyclomatic complexity is high.

---

### P-03: Latent `ReferenceError` — `LOG_PRUNE=true` Code Path
**Location:** `lib/loader.js:119–122`
**Severity:** High
**Description:** The `LOG_PRUNE` feature references `work[i]` inside its log callback, but the variable `work` does not exist anywhere in `insertAndMap()`. It was almost certainly the prior name for `transformedRecord`. Enabling `LOG_PRUNE=true` triggers a `ReferenceError` at runtime.
**Impact:** A documented environment variable (`LOG_PRUNE`) silently crashes the pipeline when enabled. Any developer troubleshooting field pruning would encounter an immediate unrelated crash.

---

### P-04: `commitComposite` Returns a Different Shape
**Location:** `lib/sf.js:124–144`
**Severity:** High
**Description:** `commitREST` and `commitBulk` both return a normalized object `{ created, updated, failures, processedRecords }`. `commitComposite` returns a raw `results[]` array. In `lib/loader.js:159`, the caller unconditionally calls `results.failures.length` — this throws a `TypeError` (`Cannot read properties of undefined`) any time `strategy.api` is `"composite"`.
**Impact:** The `composite` API option is advertised in the mapping config schema and docs but is silently broken. Any user who sets `"api": "composite"` will get a crash.

---

### P-05: `new Function()` in Filter `expr` Predicate
**Location:** `lib/filters.js:37–38`
**Severity:** High** (security) / **Medium** (operational)
**Description:** The `expr` filter predicate builds a function using `new Function("rec", "ctx", ...)`, which is equivalent to `eval`. Any string that reaches this code path is executed as JavaScript. Even with internal (developer-authored) config, this is risky; if filter specs ever come from an external source, this is a direct code execution vulnerability. Additionally, if the expression throws, the filter silently returns `false`, potentially excluding all records with no visible error (the warning only fires if `ctx.env.DEBUG_FILTERS` is set).
**Impact:** Security risk if configs are externally sourced. Silent data loss if expression has a bug.

---

### P-06: Scattered Environment Variable Access
**Location:** 8 different files (see §1.5 table)
**Severity:** Medium
**Description:** `process.env` is read directly at the call site in at least 8 modules. There is no central env config object or startup validation. Values like `AUTO_CREATE_MATCH_KEYS` are read deep inside a validator that is called from the orchestrator — the orchestrator cannot know what env vars are required by each module without reading all source code.
**Impact:** Adding a new env var requires touching 3+ files. There is no startup-time validation: a typo in `SF_USERNAME` is only discovered when the Salesforce login attempt fails with a generic error. No single place to document or enforce required vs. optional vars.

---

### P-07: Duplicated `deepMerge` Implementations
**Location:** `lib/config/utils.js:9–21`, `lib/config/step-config.js:19–37`
**Severity:** Medium
**Description:** There are two separate `deepMerge` implementations with subtly different semantics. `lib/config/utils.js` mutates the `target` argument in-place and does not use `structuredClone`. `lib/config/step-config.js` is non-mutating and uses `structuredClone`. The mutation in `utils.js` is currently safe (the first argument is always a fresh `{}`) but is a footgun — any caller passing a reused object reference would get silent shared-state corruption.
**Impact:** Two implementations to maintain; mutation footgun; behavioral inconsistency between config layers.

---

### P-08: Mixed JSON Parsers Across Config Layer
**Location:** `lib/config/utils.js` (JSON5), `lib/config/step-config.js` (JSON.parse), `lib/validators/validatematchkeys.js` (JSON.parse), `lib/loader.js` — data loaded via `readJSON` (JSON5)
**Severity:** Medium
**Description:** The config subsystem uses JSON5 for pipeline and constants files but switches to standard `JSON.parse` for object mapping configs and metadata snapshots. This means comments and trailing commas work in `pipeline.json` and `constants.json` but silently fail in mapping files like `Account.json`.
**Impact:** Inconsistent developer experience — a comment in `Contact.json` causes a parse error, but the same comment in `pipeline.json` is fine. Confusing behavior for contributors who expect uniform JSON5 support.

---

### P-09: Module-Level Side Effect in `lib/auth.js`
**Location:** `lib/auth.js:3`
**Severity:** Medium
**Description:** `dotenv.config()` is called at the top level of `auth.js`, which means `.env` is loaded as a side effect of importing the module. If `auth.js` is imported before other modules that depend on env vars, the order is implicitly correct. If import order changes or the module is used in a test context, this side effect fires unexpectedly.
**Impact:** `dotenv.config()` is called once during module load, not when `getConnection()` is called. Order-of-import dependency is invisible. Tests that mock env vars must be carefully ordered.

---

### P-10: No Pre-flight Credential Validation
**Location:** `lib/auth.js`, `scripts/runLoad.js`
**Severity:** Medium
**Description:** `SF_LOGIN_URL`, `SF_USERNAME`, and `SF_PASSWORD` are passed directly to jsforce without any presence check. If any is missing or empty, the error comes from jsforce internals (e.g., "INVALID_LOGIN: Invalid username, password, security token") with no indication of which env var is wrong.
**Impact:** Poor developer experience on first run or misconfiguration. Debug time wasted on generic API errors.

---

### P-11: No Retry or Backoff on External API Calls
**Location:** `lib/auth.js`, `lib/sf.js`, `lib/metadata.min.js`
**Severity:** Medium
**Description:** All Salesforce API calls — login, insert, upsert, bulk load, describe — are single-attempt with no retry logic. Transient network errors, Salesforce timeouts, or API concurrency limits cause immediate run failure.
**Impact:** A 5-second network hiccup during a 10-minute bulk load aborts the entire run. Users must restart from scratch. Particularly impactful for large pipelines where retrying failed batches would be sufficient.

---

### P-12: `runcontext.js` Process-Level Mutable Singleton
**Location:** `lib/runcontext.js`
**Severity:** Medium
**Description:** The org ID is stored as module-level mutable state (`let orgId = null`). The module provides explicit `resetOrgId()` for testing, but this pattern means the module carries implicit global state that survives across any hypothetical multiple pipeline runs in a single process.
**Impact:** Low risk in current architecture (one run per process), but untestable without explicit reset. If `metadata.min.js` reads `getOrgId()` in a test and the state was set by a previous test case, tests bleed state into each other.

---

### P-13: Hard-Coded Concurrency Limit
**Location:** `scripts/runLoad.js:159` — `concurrency: 2`
**Severity:** Low
**Description:** The metadata snapshot concurrency is hard-coded to `2` at the call site in `main()`. The comment says "raise carefully if needed" but there is no env var or config option to do so.
**Impact:** Minor operational friction. Users with large pipelines who need faster snapshots cannot tune this without editing source code.

---

### P-14: Dual Logging Pattern Requires Manual Sync
**Location:** Throughout `scripts/runLoad.js`
**Severity:** Low
**Description:** Every log statement in `main()` is written twice — once to `log` (console) and once to `fileLog` (run log). This dual-write is manually maintained with copy-paste, e.g.:
```js
log.info("System", "Authenticated to Salesforce ✅");
fileLog("System", "Authenticated to Salesforce ✅");
```
If one is updated, the other is often missed, leading to console/file log divergence.
**Impact:** Maintenance burden; potential log inconsistency; scales poorly as more log points are added.

---

### P-15: Generator System Is Domain-Specific and Not Pluggable
**Location:** `services/generators.js`
**Severity:** Low
**Description:** All three built-in generators are specific to the BKAI domain (field names `BKAI__Expert__c`, `BKAI__Location__c`, `BKAI__Shift_Pattern__c`). There is no mechanism to register generators without editing this file, and no documentation on how to add a new one.
**Impact:** Low reusability for other Salesforce domains. Users must edit library code to add generators instead of registering them as plugins.

---

### P-16: `validateBatch` Warns But Does Not Block
**Location:** `lib/loader.js:126`, `lib/metadata.min.js` (minified)
**Severity:** Low
**Description:** After `pruneRecordFields`, `validateBatch` is called on the pruned records. Based on the minified code's inferred behavior, it only emits warnings — it does not throw or signal that validation failed. The return value is not checked.
**Impact:** Schema validation errors are invisible unless `LOG_LEVEL=debug`. Records with bad fields proceed to the API and get rejected there, making the metadata validation layer ineffective as a gate.

---

### P-17: `console.warn` Used Instead of `log` in `commitBulk`
**Location:** `lib/sf.js:316`
**Severity:** Low
**Description:** The verification query failure in `commitBulk` uses `console.warn(...)` directly instead of the project's `log.warn(...)`. This bypasses the `LOG_LEVEL` gating and the standard timestamp/tag format.
**Impact:** Log format inconsistency; this message is always visible regardless of `LOG_LEVEL`; does not appear in the run log file.

---

### P-18: No jsforce Connection Cleanup
**Location:** `scripts/runLoad.js:main()`
**Severity:** Low
**Description:** The jsforce connection is created in `main()` but never explicitly logged out or closed when the run completes or fails. jsforce connections eventually expire server-side, but there is no `conn.logout()` in the success path or the error handler.
**Impact:** Minor resource leak; session lingers on Salesforce until timeout. Not harmful for short runs but adds unnecessary active sessions.

---

## Phase 3: Improvement Recommendations

---

### R-01: Decompile and Restore Minified Source Files
**Addresses:** P-01 (Minified Sources)
**Effort:** Medium (1–3 days)
**Priority:** P1 — do now

**Approach:**
1. Use a JS decompiler (e.g., `prettier` + manual cleanup, or `deobfuscate-js`) to expand `lib/metadata.min.js` and `lib/utils.min.js` into readable source.
2. Add JSDoc comments to each exported function.
3. Rename single-character variables to descriptive names.
4. Verify behavior is unchanged by running the Sales Cloud pipeline against a scratch org before and after.
5. Delete the `.min.js` files and update all import statements.

**Before:**
```js
// lib/metadata.min.js (excerpt — actual minified)
export async function snapshotOrgMetadata(e,{objectNames:t,metaDir:r,...
```

**After:**
```js
// lib/metadata.js
/**
 * Fetch and cache Salesforce describe metadata for a list of objects.
 * @param {jsforce.Connection} conn
 * @param {object} opts
 * @param {string[]} opts.objectNames - API names to snapshot
 * @param {string}   opts.metaDir    - Local cache directory
 * @param {string}   [opts.orgId]    - Override org ID (normally resolved from conn)
 * @param {boolean}  [opts.forceRefresh=false]
 * @param {number}   [opts.concurrency=2]
 * @returns {Promise<{ orgId: string, unavailableObjects: string[] }>}
 */
export async function snapshotOrgMetadata(conn, { objectNames, metaDir, orgId, forceRefresh = false, concurrency = 2 }) {
  // ... readable implementation
}
```

**Risk:** Behavioral difference if decompiler misreads compressed logic. Mitigate: run full pipeline integration test before and after.

---

### R-02: Extract Pipeline Orchestrator from Entry Point
**Addresses:** P-02 (God File — runLoad.js)
**Effort:** Medium (1–3 days)
**Priority:** P1 — do now

**Approach:**
1. Create `lib/pipeline/orchestrator.js` with a single `runPipeline(conn, pipelineCfg, options)` function that contains the step execution loop.
2. Move `topoSortSteps()` to `lib/pipeline/toposort.js`.
3. Move `runGenerator()` dispatch to `lib/pipeline/generators.js` (separate from `services/generators.js`).
4. Move `loadDataFile()` and its cache to `lib/pipeline/dataloader.js`.
5. Move `upsertIdMap()` into `orchestrator.js` as an internal helper.
6. Leave `scripts/runLoad.js` responsible only for: reading env, calling auth, instantiating config, calling `runPipeline`, and handling the top-level error.

**Before (`scripts/runLoad.js:main()`):**
```js
async function main() {
  runLog = createRunLogSingle("logs");
  // auth ... config ... snapshot ... toposort ... validate ... step loop
  // 250+ lines of mixed concerns
}
```

**After (`scripts/runLoad.js`):**
```js
async function main() {
  const runLog  = createRunLogSingle("logs");
  const logger  = createDualLogger(log, runLog);
  const conn    = await getConnection();
  const config  = await loadRunConfig({ envName: ENV_NAME });
  await runPipeline(conn, config, { logger, dryRun: DRY_RUN });
  runLog.close();
}
```

**Risk:** Low — pure refactor with no behavior change. Verify with full pipeline run.

---

### R-03: Fix `commitComposite` Return Shape
**Addresses:** P-04 (commitComposite broken shape)
**Effort:** Small (< 1 day)
**Priority:** P1 — do now

**Approach:**
Update `commitComposite` to return the same normalized shape as `commitREST`. Since it currently delegates to per-record REST calls, wrap the final results into `{ operation, created, updated, failures, processedRecords }`.

**Before:**
```js
async function commitComposite(conn, objectName, batch, strategy) {
  const results = [];
  for (const rec of batch) {
    // ...
    results.push(res);
  }
  return results; // ← raw array, breaks caller
}
```

**After:**
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

**Risk:** Low — improves correctness, no other callers affected.

---

### R-04: Fix `LOG_PRUNE` ReferenceError
**Addresses:** P-03 (Latent ReferenceError)
**Effort:** Small (< 1 day)
**Priority:** P1 — do now

**Approach:**
Replace `work[i]` with `transformedRecord[i]` (the variable that holds the pre-prune records) in `lib/loader.js:121`.

**Before:**
```js
pruned.slice(0,2).map((r,i) => ({ rec: i+1, removed: diff(work[i], r) }))
```

**After:**
```js
pruned.slice(0,2).map((r,i) => ({ rec: i+1, removed: diff(transformedRecord[i], r) }))
```

**Risk:** None — this is a clear bug fix. Verify by running with `LOG_PRUNE=true`.

---

### R-05: Create a Centralized Environment Config Module
**Addresses:** P-06 (Scattered env access), P-10 (No credential validation)
**Effort:** Small (< 1 day)
**Priority:** P1 — do now

**Approach:**
1. Create `lib/config/env.js` that reads all env vars once, validates required ones, and exports a typed config object.
2. Update all modules to import from this file instead of reading `process.env` directly.
3. Move `dotenv.config()` call from `lib/auth.js` to the top of `scripts/runLoad.js` (before any imports that read env).

**Before (scattered across 8 files):**
```js
// lib/auth.js
dotenv.config();
const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL });
await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);

// lib/validators/validatematchkeys.js
const AUTO_CREATE = String(process.env.AUTO_CREATE_MATCH_KEYS || "").toLowerCase() === "true";
```

**After (`lib/config/env.js`):**
```js
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

**Risk:** Low. The only behavioral change is that missing credentials fail fast at startup with a clear message rather than at login time.

---

### R-06: Unify JSON Parser Across Config Layer
**Addresses:** P-08 (Mixed parsers)
**Effort:** Small (< 1 day)
**Priority:** P2 — next sprint

**Approach:**
1. Update `lib/config/step-config.js:readJson()` to use JSON5 instead of `JSON.parse`.
2. Update `lib/validators/validatematchkeys.js:readJSON()` to use JSON5 (or import from `lib/config/utils.js`).
3. Eliminate the private `readJSON` in `validatematchkeys.js` and re-use the shared one from `lib/config/utils.js`.

**Before (`lib/config/step-config.js`):**
```js
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw); // ← no JSON5, no BOM strip
}
```

**After:**
```js
import { readJSON } from './utils.js'; // reuse JSON5-aware, BOM-stripping reader
```

**Risk:** Negligible. JSON5 is a superset of JSON — all valid JSON files parse identically. Only behavioral change is that JSON5 comments and trailing commas now work in mapping files.

---

### R-07: Create a Unified Dual-Logger
**Addresses:** P-14 (Manual dual-write logging)
**Effort:** Small (< 1 day)
**Priority:** P2 — next sprint

**Approach:**
Create `lib/utils/duallogger.js` that wraps both `log` and `runLog` and routes a single call to both.

**Before (repeated throughout `main()`):**
```js
log.info("System", "Authenticated to Salesforce ✅");
fileLog("System", "Authenticated to Salesforce ✅");
```

**After:**
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
    json:  (tag, label, obj) => { consoleLog.debug?.(tag, label); runLog.writeJson(tag, label, obj); },
  };
}

// usage in main()
const logger = createDualLogger(log, runLog);
logger.info("System", "Authenticated to Salesforce ✅");
```

**Risk:** None — pure wrapper addition.

---

### R-08: Consolidate `deepMerge` into Single Shared Implementation
**Addresses:** P-07 (Duplicate deepMerge)
**Effort:** Small (< 1 day)
**Priority:** P2 — next sprint

**Approach:**
1. Adopt the non-mutating implementation from `lib/config/step-config.js` as canonical.
2. Update `lib/config/utils.js:deepMerge()` to use the non-mutating version.
3. Remove the private `deepMerge` from `lib/config/step-config.js` and import from `lib/config/utils.js`.

**Before:**
```js
// lib/config/utils.js — mutates target
export function deepMerge(target, ...sources) {
  for (const src of sources) {
    // ...mutate target[k] in-place
  }
  return target;
}
```

**After:**
```js
// lib/config/utils.js — non-mutating
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

**Risk:** The calling pattern in `loadPipeline`/`loadConstants` is `deepMerge({}, base, env)` — the current mutation of `{}` is safe but the updated version needs to handle variadic args. Adjust to `sources.reduce(deepMerge, {})`. Verify with pipeline + env overlay scenarios.

---

### R-09: Add Retry Wrapper for External API Calls
**Addresses:** P-11 (No retry/backoff)
**Effort:** Medium (1–3 days)
**Priority:** P2 — next sprint

**Approach:**
1. Create `lib/utils/retry.js` with an exponential-backoff `withRetry(fn, opts)` utility.
2. Wrap `getConnection()` in `auth.js`, and individual batch commits in `sf.js`.
3. Do NOT retry validation or metadata creation operations — those are not idempotent.

**Pseudocode (`lib/utils/retry.js`):**
```js
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

// usage in sf.js
const results = await withRetry(
  () => conn.bulk2.loadAndWaitForResults({ ... }),
  { maxAttempts: 3, retryOn: (e) => e.code === 'ECONNRESET' || e.errorCode === 'REQUEST_LIMIT_EXCEEDED' }
);
```

**Risk:** Retry on non-idempotent operations could cause duplicate inserts. The `retryOn` predicate must be carefully specified to only retry transient errors.

---

### R-10: Move `dotenv.config()` to Entry Point
**Addresses:** P-09 (Side effect import in auth.js)
**Effort:** Small (< 1 day)
**Priority:** P2 — next sprint

**Approach:**
Remove `dotenv.config()` from `lib/auth.js` and add it as the very first line of `scripts/runLoad.js`, before any other imports.

**Before (`lib/auth.js:3`):**
```js
import dotenv from "dotenv";
dotenv.config(); // ← side effect on module import
```

**After (`scripts/runLoad.js:1`):**
```js
import dotenv from "dotenv";
dotenv.config(); // ← explicit, at entry point, before all other imports

import { getConnection } from "../lib/auth.js";
// ...
```

**Note:** In ESM, all `import` statements are hoisted. Use a dynamic import pattern or a loader flag if the dotenv load must happen before static imports resolve. Alternative: use `dotenv/config` import (`import 'dotenv/config'`) as the very first static import.

**Risk:** Low. Verify env vars are available to all modules after move.

---

### R-11: Add Configurable Metadata Snapshot Concurrency
**Addresses:** P-13 (Hard-coded concurrency)
**Effort:** Small (< 1 day)
**Priority:** P3 — backlog

**Approach:**
Read `META_CONCURRENCY` from env config (see R-05) and pass it through to `snapshotOrgMetadata`.

**Before (`scripts/runLoad.js:159`):**
```js
concurrency: 2  // hard-coded
```

**After:**
```js
concurrency: envConfig.loader.metaConcurrency  // from env, default 2
```

**Risk:** None. Increasing concurrency may hit Salesforce API limits; default of 2 remains safe.

---

### R-12: Make `validateBatch` Throw on Invalid Fields
**Addresses:** P-16 (validateBatch warns but doesn't block)
**Effort:** Small (< 1 day)
**Priority:** P3 — backlog

**Approach:**
After restoring `lib/metadata.min.js` to readable source (R-01), update `validateBatch` to return an error list and throw if any records contain fields that are unknown after pruning. This catches schema drift where a field was pruned but shouldn't have been (e.g., a field that was writable yesterday is now read-only due to a profile change).

**Before (inferred from minified):**
```js
// validateBatch warns silently
export function validateBatch(objectName, records, fieldMap, opts) {
  // logs warnings but returns void
}
```

**After:**
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

**Risk:** Enabling `strict: true` may break existing pipelines where fields are intentionally present but pruned. Start with warning-only, add `strict` flag as opt-in.

---

### R-13: Replace `expr` Predicate `new Function` with Safe Evaluator
**Addresses:** P-05 (eval-equivalent security)
**Effort:** Medium (1–3 days)
**Priority:** P3 — backlog

**Approach:**
Replace `new Function()` in `lib/filters.js` with a limited expression evaluator that supports only field access, comparison operators, and boolean combinators — no arbitrary code execution.

Options:
- **`filtrex`** (npm) — safe expression evaluator, no eval
- **`expr-eval`** (npm) — math/logic expression parser
- **Custom micro-parser** — sufficient for `rec.Field > 5 && rec.Name !== null` patterns

**Before:**
```js
function buildExprRunner(expr) {
  const fn = new Function("rec", "ctx", `return (${expr});`); // ← eval
  return (rec, ctx) => !!fn(rec, ctx);
}
```

**After:**
```js
import { Parser } from 'expr-eval';
const parser = new Parser();
function buildExprRunner(expr) {
  const compiled = parser.parse(expr); // safe, no eval
  return (rec, ctx) => !!compiled.evaluate({ ...rec, ...ctx });
}
```

**Risk:** Breaking change for any existing `expr` predicates that use JS syntax not supported by the evaluator. Audit all existing filter specs before switching.

---

## Phase 4: Target Architecture

### 4.1 Proposed Folder Structure

```
cloudseeder/
│
├── scripts/
│   └── runLoad.js                  # Thin entry point: env → auth → runPipeline → exit
│
├── lib/
│   ├── pipeline/
│   │   ├── orchestrator.js         # runPipeline(): top-level step execution loop
│   │   ├── toposort.js             # topoSortSteps(): pure topological sort
│   │   ├── dataloader.js           # loadDataFile() with memoization cache
│   │   └── generators.js           # runGenerator() dispatcher
│   │
│   ├── transform/
│   │   ├── shape.js                # shapeRecord(): fieldMap, defaults, removeFields
│   │   ├── transforms.js           # applyTransforms(): assign, copy, rename, remove, etc.
│   │   ├── constants.js            # resolveConstantsDeep(): ${constants.*} interpolation
│   │   ├── ref-solver.js           # resolveReferences(): foreign key resolution (existing, rename from mapping/)
│   │   └── index.js                # Re-export all transforms
│   │
│   ├── loader.js                   # insertAndMap(): compose transforms + commit (reduced scope)
│   │
│   ├── salesforce/
│   │   ├── auth.js                 # getConnection() (existing lib/auth.js — moved)
│   │   ├── commit.js               # commit(), commitREST(), commitComposite(), commitBulk() (existing lib/sf.js — moved)
│   │   ├── metadata.js             # snapshotOrgMetadata(), pruneRecordFields(), etc. (decompiled metadata.min.js)
│   │   └── permset.js              # Permission Set management (existing lib/utils/permset.js — moved)
│   │
│   ├── validators/
│   │   ├── matchkeys.js            # validateMatchKeysFromSnapshots() (existing — renamed)
│   │   └── schema.js              # validateBatch() extracted from metadata.js
│   │
│   ├── config/
│   │   ├── env.js                  # NEW: loadEnvConfig() — single env var source of truth
│   │   ├── pipeline.js             # loadPipeline()
│   │   ├── constants.js            # loadConstants()
│   │   ├── step-config.js          # loadStepConfig()
│   │   ├── utils.js                # readJSON(), deepMerge() (single canonical implementation)
│   │   └── index.js                # Re-exports
│   │
│   └── utils/
│       ├── logger.js               # console logger (existing)
│       ├── runlog.js               # run log file writer (existing)
│       ├── duallogger.js           # NEW: createDualLogger()
│       ├── retry.js                # NEW: withRetry() exponential backoff
│       └── runcontext.js           # org ID singleton (existing — moved from lib/)
│
├── services/
│   └── generators.js               # User-defined generators (BKAI examples)
│
├── config/                         # User configuration (unchanged)
│   ├── pipeline.json
│   ├── constants.json
│   └── ...
│
├── meta-data/                      # (generated) org describe cache
└── logs/                           # (generated) run logs
```

---

### 4.2 Module Responsibility Map

| Module | Owns Exactly |
|---|---|
| `scripts/runLoad.js` | Process entry: env init, auth, invoke orchestrator, top-level error handling |
| `lib/pipeline/orchestrator.js` | Step execution loop: iterate sorted steps, dispatch load, accumulate idMaps, emit run report |
| `lib/pipeline/toposort.js` | Topological sort of steps by `dependsOn` — pure function, no I/O |
| `lib/pipeline/dataloader.js` | Load and memoize JSON/JSON5 seed data files |
| `lib/pipeline/generators.js` | Dispatch to registered generator functions |
| `lib/transform/shape.js` | Apply fieldMap, defaults, removeFields to a single record |
| `lib/transform/transforms.js` | Execute assign/copy/rename/remove/coalesce/concat operations |
| `lib/transform/constants.js` | Interpolate `${constants.*}` placeholders in config or records |
| `lib/transform/ref-solver.js` | Resolve declarative foreign key references using idMaps |
| `lib/loader.js` | Compose transform pipeline + prune + validate + batch + commit for one object |
| `lib/salesforce/auth.js` | Create authenticated jsforce connection |
| `lib/salesforce/commit.js` | Route to REST/Composite/Bulk commit strategy; return normalized result |
| `lib/salesforce/metadata.js` | Snapshot org describe, cache to disk, load from cache, prune record fields |
| `lib/salesforce/permset.js` | Create Permission Sets, grant FLS, assign to users |
| `lib/validators/matchkeys.js` | Validate mapping matchKey fields exist in org; auto-create if configured |
| `lib/validators/schema.js` | Validate record fields against org describe (post-prune gate) |
| `lib/config/env.js` | Read, validate, and export all environment variables as typed object |
| `lib/config/pipeline.js` | Load pipeline.json with env overlay |
| `lib/config/constants.js` | Load constants.json with env overlay |
| `lib/config/step-config.js` | Load + 4-layer-merge object mapping config (cached) |
| `lib/config/utils.js` | Shared `readJSON` (JSON5) and canonical `deepMerge` |
| `lib/utils/logger.js` | Level-gated console logging |
| `lib/utils/runlog.js` | Per-run append-mode file logging |
| `lib/utils/duallogger.js` | Route a single log call to both console and file loggers |
| `lib/utils/retry.js` | Exponential backoff wrapper for async operations |
| `lib/utils/runcontext.js` | Process-lifetime org ID singleton |
| `services/generators.js` | Domain-specific data generators (BKAI examples; extensible) |
| `lib/filters.js` | Evaluate declarative filter predicates against records |

---

### 4.3 Layered Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     CLI Entry Point                              │
│                  scripts/runLoad.js                              │
│   (env init · auth · invoke orchestrator · top-level catch)      │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                  Pipeline Orchestrator                            │
│              lib/pipeline/orchestrator.js                        │
│   (step loop · toposort · snapshot · match key validation ·      │
│    run report · idMap accumulation)                              │
└──────────┬───────────────────────────────────┬───────────────────┘
           │                                   │
┌──────────▼──────────┐             ┌──────────▼──────────────────┐
│   Data Pipeline     │             │      Generator Dispatch      │
│   lib/loader.js     │             │  lib/pipeline/generators.js  │
│   (compose:         │             │  services/generators.js      │
│    shape → pre →    │             └─────────────────────────────-┘
│    refs → post →    │
│    prune → assert → │
│    unique → batch)  │
└──────────┬──────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                    Transform Layer                               │
│   lib/transform/shape.js  ·  transforms.js  ·  constants.js     │
│   lib/transform/ref-solver.js  ·  lib/filters.js                │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                  Salesforce API Layer                            │
│   lib/salesforce/commit.js   (REST · Composite · Bulk 2.0)      │
│   lib/salesforce/metadata.js (describe · prune · validate)      │
│   lib/salesforce/auth.js     (jsforce connection)               │
│   lib/salesforce/permset.js  (FLS · Permission Sets)            │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                   Config & Validation Layer                      │
│   lib/config/env.js  ·  pipeline.js  ·  constants.js            │
│   lib/config/step-config.js  ·  utils.js  (JSON5 · deepMerge)   │
│   lib/validators/matchkeys.js  ·  schema.js                     │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                    Infrastructure Layer                          │
│   lib/utils/logger.js  (console · level-gated · timestamped)    │
│   lib/utils/runlog.js  (per-run file · append-mode)             │
│   lib/utils/duallogger.js  (single call → console + file)       │
│   lib/utils/retry.js  (exponential backoff · retryOn predicate) │
│   lib/utils/runcontext.js  (org ID singleton)                   │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.4 Key Design Patterns to Adopt

#### Strategy Pattern — Already Present, Needs Completion
**Why it fits:** `lib/sf.js` already implements three commit strategies (`commitREST`, `commitComposite`, `commitBulk`) dispatched by `strategy.api`. This is the Strategy pattern in spirit.
**Problem:** `commitComposite` breaks the interface contract (different return shape).
**What to change:** Make all three strategies implement the same interface signature:
```
CommitResult = { operation, created[], updated[], failures[], processedRecords[] }
```
**Pseudocode:**
```js
// lib/salesforce/commit.js
const STRATEGIES = {
  rest:       commitREST,
  composite:  commitComposite,
  bulk:       commitBulk,
};

export async function commit(conn, objectName, batch, strategy) {
  const fn = STRATEGIES[strategy.api] ?? commitREST;
  return fn(conn, objectName, batch, strategy); // uniform return shape guaranteed
}
```

---

#### Pipeline Pattern — Formalize the Transform Chain
**Why it fits:** The transform sequence (constants → pre → shape → refs → post → prune → validate) is already a pipeline. Currently these are sequential imperative calls inside `loader.js`.
**What to change:** Make each stage a composable function with the same signature: `(record, context) → record`. This allows stages to be reordered, skipped, or extended without modifying the loop.
**Pseudocode:**
```js
// lib/loader.js
const pipeline = [
  (rec, ctx) => resolveConstantsDeep(rec, ctx.constants),
  (rec, ctx) => applyTransforms(rec, ctx.cfg.transform.pre),
  (rec, ctx) => shapeRecord(rec, ctx.cfg),
  (rec, ctx) => resolveReferences(rec, ctx.cfg.references, ctx.idMaps, ctx.objectName),
  (rec, ctx) => applyTransforms(rec, ctx.cfg.transform.post),
];

const processed = records.map(rec =>
  pipeline.reduce((r, stage) => stage(r, ctx), { ...rec })
);
```

---

#### Registry Pattern — Generator Extensibility
**Why it fits:** `services/generators.js` hard-codes domain-specific generators. New generators require editing library source code.
**What to change:** Introduce a generator registry that allows external registration. The pipeline step can specify a generator by name; the registry resolves it.
**Pseudocode:**
```js
// lib/pipeline/generators.js
const registry = new Map();

export function registerGenerator(name, fn) {
  if (typeof fn !== 'function') throw new Error(`Generator '${name}' must be a function`);
  registry.set(name, fn);
}

export function runGenerator(name, data, idMaps) {
  const fn = registry.get(name);
  if (!fn) throw new Error(`Generator '${name}' not registered. Call registerGenerator() first.`);
  return fn(data, idMaps);
}
```

---

## Phase 5: Migration Roadmap

### Step 1 — Foundation (Zero Functional Risk)

**Goal:** Improve readability and fix critical bugs without changing behavior.

| # | Change | Files Affected | Priority |
|---|---|---|---|
| 1a | Fix `LOG_PRUNE` `ReferenceError` (`work` → `transformedRecord`) | `lib/loader.js:121` | P1 |
| 1b | Fix `commitComposite` return shape | `lib/sf.js:124–144` | P1 |
| 1c | Replace `console.warn` with `log.warn` in `commitBulk` | `lib/sf.js:316` | P1 |
| 1d | Move `dotenv.config()` to entry point | `lib/auth.js`, `scripts/runLoad.js` | P2 |
| 1e | Decompile `lib/metadata.min.js` → `lib/metadata.js` | `lib/metadata.min.js`, all importers | P1 |
| 1f | Decompile `lib/utils.min.js` → `lib/utils.js` (split into `transform/`) | `lib/utils.min.js`, all importers | P1 |
| 1g | Consolidate `deepMerge` to single implementation in `lib/config/utils.js` | `lib/config/utils.js`, `lib/config/step-config.js` | P2 |
| 1h | Unify JSON parser: use JSON5 in `step-config.js` and `validatematchkeys.js` | `lib/config/step-config.js`, `lib/validators/validatematchkeys.js` | P2 |

**How to verify Step 1:**
- Run `npm start` against the bundled Sales Cloud pipeline (`DRY_RUN=true` then live)
- Run with `LOG_PRUNE=true` to verify no crash
- Run with `strategy.api: "composite"` in one mapping config to verify it no longer crashes

---

### Step 2 — Refactor (Restructuring Without Behavior Change)

**Goal:** Introduce clean module boundaries and remove god-file antipatterns.

| # | Change | Files Affected |
|---|---|---|
| 2a | Create `lib/config/env.js` (centralized env config) | New file; update all `process.env` call sites |
| 2b | Create `lib/utils/duallogger.js`; replace manual dual-write in `runLoad.js` | New file; `scripts/runLoad.js` |
| 2c | Extract `topoSortSteps` to `lib/pipeline/toposort.js` | New file; `scripts/runLoad.js` |
| 2d | Extract `runGenerator` dispatch to `lib/pipeline/generators.js` | New file; `scripts/runLoad.js` |
| 2e | Extract step execution loop into `lib/pipeline/orchestrator.js` | New file; `scripts/runLoad.js` |
| 2f | Move `lib/auth.js` → `lib/salesforce/auth.js` | Move; update importers |
| 2g | Move `lib/sf.js` → `lib/salesforce/commit.js` | Move; update importers |
| 2h | Move `lib/utils/permset.js` → `lib/salesforce/permset.js` | Move; update importers |
| 2i | Move `lib/runcontext.js` → `lib/utils/runcontext.js` | Move; update importers |
| 2j | Split decompiled transforms into `lib/transform/` modules | New files; update `lib/loader.js` |

**How to verify Step 2:**
- After each move/extract: `npm start` full pipeline run
- Check that log output is identical before and after (same messages, same file)
- Spot-check that all import paths resolve (no `ERR_MODULE_NOT_FOUND`)

---

### Step 3 — Harden (Add Missing Robustness)

**Goal:** Make the system more resilient and self-validating.

| # | Change | Files Affected |
|---|---|---|
| 3a | Add startup credential validation in `lib/config/env.js` | `lib/config/env.js` |
| 3b | Create `lib/utils/retry.js`; wrap batch commits in `lib/salesforce/commit.js` | New file; `lib/salesforce/commit.js` |
| 3c | Fix silent failure in `main().catch()` — remove empty inner catch | `scripts/runLoad.js:326` |
| 3d | Make `validateBatch` return error list; add `strict` mode | `lib/salesforce/metadata.js` (after decompile) |
| 3e | Add `conn.logout()` in run completion and error paths | `scripts/runLoad.js` |
| 3f | Add configurable `META_CONCURRENCY` env var (R-11) | `lib/config/env.js`, `scripts/runLoad.js` |
| 3g | Fix `log.info` used for errors in `lib/loader.js` DML failure path | `lib/loader.js:160,178,189` |

**How to verify Step 3:**
- Simulate network failure mid-run (disconnect Wi-Fi during bulk load); verify retry fires and run continues
- Set `AUTO_CREATE_MATCH_KEYS=false` with missing field; verify clear startup error
- Run with invalid credentials; verify "Missing required env vars" error, not generic jsforce error

---

### Step 4 — Extend (Unlock New Capabilities)

**Goal:** Enable testability, pluggability, and safer advanced features.

| # | Change | Files Affected |
|---|---|---|
| 4a | Implement `lib/pipeline/generators.js` registry with `registerGenerator()` | New file; `services/generators.js` |
| 4b | Pass `envConfig` as argument instead of reading `process.env` in validators | `lib/validators/matchkeys.js`, all callers |
| 4c | Replace `new Function()` in `lib/filters.js expr` with `expr-eval` or `filtrex` | `lib/filters.js` |
| 4d | Add `--config` CLI flag to override `config/` directory path | `scripts/runLoad.js`, `lib/config/env.js` |
| 4e | Add JSON Schema validation for pipeline.json and mapping configs | New `lib/validators/configschema.js` |
| 4f | Add `runcontext` as injected dependency (not module singleton) | `lib/utils/runcontext.js`, all callers |

**How to verify Step 4:**
- Register a custom generator via `registerGenerator('myGen', fn)` in a test harness; run pipeline
- Write a filter with `expr: "rec.Amount > 5000"` and verify it works without `new Function`
- Provide a malformed `pipeline.json`; verify JSON Schema error is clear and fast

---

## Summary Priority Matrix

| Priority | Recommendation | Effort | Impact |
|---|---|---|---|
| **P1** | R-04: Fix LOG_PRUNE ReferenceError | Small | Fixes latent crash |
| **P1** | R-03: Fix commitComposite return shape | Small | Fixes silent broken feature |
| **P1** | R-01: Decompile minified source files | Medium | Unlocks all future maintenance |
| **P1** | R-05: Centralize env config + credential validation | Small | Clear startup errors; single source of truth |
| **P2** | R-02: Extract pipeline orchestrator | Medium | Reduces god file, improves testability |
| **P2** | R-07: Unified dual-logger | Small | Eliminates manual sync pattern |
| **P2** | R-06: Unified JSON parser (JSON5 everywhere) | Small | Consistent developer experience |
| **P2** | R-08: Single deepMerge implementation | Small | Eliminates footgun mutation |
| **P2** | R-10: Move dotenv to entry point | Small | Removes import side effect |
| **P2** | R-09: Retry wrapper for API calls | Medium | Resilience to transient failures |
| **P3** | R-11: Configurable meta concurrency | Small | Operational tuning |
| **P3** | R-12: validateBatch as gate, not warning | Small | Effective schema validation |
| **P3** | R-13: Replace expr new Function with safe evaluator | Medium | Security hardening |

---

*End of architectural review. Each recommendation is incremental — no full rewrites required. Start with P1 items; they are the highest-impact, lowest-risk changes in the codebase.*
