# Migration Roadmap — CloudSeeder

**Review Date:** 2026-03-12
**Goal:** Migrate from current state to [target architecture](target-architecture.md) safely and incrementally.

Each step is independently deployable. Complete verification before moving to the next step.

---

## Roadmap Overview

| Step | Name | Description | Effort | Risk | Dependencies | Status |
|---|---|---|---|---|---|---|
| 1 | Foundation | Fix critical bugs; decompile minified files; unify config utilities | ~5 days | Low | None | Open |
| 2 | Refactor | Extract orchestrator; introduce clean module boundaries; reorganize folders | ~5 days | Medium | Step 1 | Open |
| 3 | Harden | Add startup validation, retry logic, proper error handling | ~3 days | Medium | Step 2 | Open |
| 4 | Extend | Generator registry, safe filter evaluator, injected dependencies, config schema | ~4 days | Low–Medium | Step 3 | Open |

---

## Detailed Steps

---

### Step 1: Foundation

#### Goal
Fix every known bug and remove all code-quality blockers that prevent future work. After this step, the codebase behaves identically to today but is fully readable, consistent, and free of known crashes.

#### Risk Level
Low — all changes are either bug fixes or behavior-preserving refactors within a single file.

#### Depends On
None — start here.

#### Tasks

**Critical bug fixes (P1):**
- [ ] Fix `LOG_PRUNE` `ReferenceError`: rename `work[i]` → `transformedRecord[i]` — `lib/loader.js:121` — 30 min
- [ ] Fix `commitComposite` return shape: return `{ operation, created, updated, failures, processedRecords }` — `lib/sf.js:124–144` — 2 hrs
- [ ] Replace `console.warn` with `log.warn` in `commitBulk` verification failure — `lib/sf.js:316` — 15 min

**Decompile minified files (P1 — blocks all future maintenance):**
- [ ] Decompile `lib/metadata.min.js` → `lib/metadata.js` — add JSDoc, rename single-char vars — 1–2 days
- [ ] Decompile `lib/utils.min.js` → `lib/utils.js` — add JSDoc, rename single-char vars — 1–2 days
- [ ] Update all import statements from `.min.js` to readable equivalents — `lib/loader.js`, `scripts/runLoad.js` — 30 min
- [ ] Delete `lib/metadata.min.js` and `lib/utils.min.js` from repository — 5 min

**Config layer cleanup (P2):**
- [ ] Consolidate `deepMerge` — adopt non-mutating version from `step-config.js` as canonical in `lib/config/utils.js` — `lib/config/utils.js`, `lib/config/step-config.js` — 1 hr
- [ ] Unify JSON parser — replace `JSON.parse` with `readJSON` (JSON5) in `step-config.js` and `validatematchkeys.js` — 1 hr

#### Verification
- [ ] `npm start` full pipeline run with `DRY_RUN=true`; output identical to pre-change
- [ ] `npm start` full live run against scratch org; results identical
- [ ] `LOG_PRUNE=true npm start` — no `ReferenceError`; pruning diff logged correctly
- [ ] Set `"api": "composite"` in one mapping config; confirm run completes and idMap entries are correct
- [ ] Add a trailing comma to a mapping `.json` file; confirm it parses without error

#### Rollback Plan
Each task is a single-file change. Revert with `git checkout lib/loader.js` (etc.) per task. The decompile work should be done on a dedicated branch; revert the branch merge if issues arise.

---

### Step 2: Refactor

#### Goal
Introduce clean module boundaries without changing any observable behavior. After this step, the folder structure matches the [target architecture](target-architecture.md) and the entry point is a thin orchestrator.

#### Risk Level
Medium — involves moving files and reorganizing import graphs. No logic changes, but import path errors are possible.

#### Depends On
Step 1 (especially the decompile — split transforms need readable source).

#### Tasks

**Environment config (prerequisite for everything else in this step):**
- [ ] Create `lib/config/env.js` with `loadEnvConfig()` — reads and exports all env vars — 2 hrs
- [ ] Update all `process.env` call sites to import from `lib/config/env.js` — 8 files — 1 hr
- [ ] Move `dotenv.config()` from `lib/auth.js` to `scripts/runLoad.js` (use `import 'dotenv/config'`) — 15 min

**Logging:**
- [ ] Create `lib/utils/duallogger.js` with `createDualLogger()` — 30 min
- [ ] Replace all manual `log.X / fileLog` dual-write pairs in `scripts/runLoad.js` with `logger.X` — 1 hr

**Pipeline extraction (reduces god file):**
- [ ] Create `lib/pipeline/toposort.js` — move `topoSortSteps()` from `scripts/runLoad.js` — 30 min
- [ ] Create `lib/pipeline/dataloader.js` — move `loadDataFile()` + cache from `scripts/runLoad.js` — 30 min
- [ ] Create `lib/pipeline/generators.js` — move generator dispatch logic from `scripts/runLoad.js` — 30 min
- [ ] Create `lib/pipeline/orchestrator.js` — extract step execution loop from `scripts/runLoad.js` — 3 hrs
- [ ] Reduce `scripts/runLoad.js` `main()` to: env init → auth → load config → `runPipeline()` → close — 1 hr

**Salesforce layer consolidation:**
- [ ] Move `lib/auth.js` → `lib/salesforce/auth.js`; update all importers — 30 min
- [ ] Move `lib/sf.js` → `lib/salesforce/commit.js`; update all importers — 30 min
- [ ] Move `lib/metadata.js` → `lib/salesforce/metadata.js`; update all importers — 30 min
- [ ] Move `lib/utils/permset.js` → `lib/salesforce/permset.js`; update all importers — 30 min

**Transform layer extraction:**
- [ ] Create `lib/transform/` directory — extract `shapeRecord`, `applyTransforms`, `resolveConstantsDeep` from decompiled `lib/utils.js` into separate modules — 2 hrs
- [ ] Move `lib/mapping/ref-solver.js` → `lib/transform/ref-solver.js` — 15 min
- [ ] Update `lib/loader.js` to import from `lib/transform/` modules — 30 min

**Misc moves:**
- [ ] Move `lib/runcontext.js` → `lib/utils/runcontext.js`; update all importers — 15 min

#### Verification
- [ ] After each file move: `npm start` full pipeline run; confirm no `ERR_MODULE_NOT_FOUND`
- [ ] After orchestrator extraction: compare log output line-by-line against Step 1 baseline
- [ ] Confirm `scripts/runLoad.js` `main()` is ≤ 30 lines
- [ ] Confirm no `process.env` reads outside `lib/config/env.js` (grep check)

#### Rollback Plan
All moves should be done on a single feature branch. If a move introduces an import error that can't be quickly resolved, revert the entire branch. Do not merge partial moves.

---

### Step 3: Harden

#### Goal
Make the system self-validating and resilient. After this step, missing config produces clear errors at startup, transient network failures trigger automatic retry, and all error paths are properly handled.

#### Risk Level
Medium — retry logic must be carefully scoped to idempotent operations only.

#### Depends On
Step 2 (env config module must exist; orchestrator must be extracted).

#### Tasks

**Startup validation:**
- [ ] Add required env var check to `lib/config/env.js` — throw with clear message listing all missing vars — 30 min
- [ ] Add `META_CONCURRENCY` to `lib/config/env.js`; pass to `snapshotOrgMetadata` — `lib/config/env.js`, `lib/salesforce/metadata.js` — 30 min

**Retry logic:**
- [ ] Create `lib/utils/retry.js` with `withRetry(fn, opts)` exponential backoff — 1 hr
- [ ] Wrap `getConnection()` in `lib/salesforce/auth.js` with `withRetry` — 30 min
- [ ] Wrap batch commits in `lib/salesforce/commit.js` with `withRetry` (transient errors only — use `retryOn` predicate) — 1 hr

**Error handling fixes:**
- [ ] Fix empty inner `catch {}` in `scripts/runLoad.js:326` — log secondary errors instead of swallowing — 15 min
- [ ] Fix `log.info` used for DML failure path in `lib/loader.js` — change to `log.error` — `lib/loader.js:160,178,189` — 15 min
- [ ] Add `conn.logout()` in success path and error handler in `scripts/runLoad.js` — 30 min

**Schema validation:**
- [ ] Update `validateBatch` in `lib/salesforce/metadata.js` to return error list — warn by default; add `strict` opt-in flag — 1 hr

#### Verification
- [ ] Remove `SF_USERNAME` from `.env`; confirm startup error names the missing variable before any network call
- [ ] Set `META_CONCURRENCY=4`; confirm snapshot phase uses higher concurrency
- [ ] Simulate network failure mid-bulk-load; confirm `withRetry` fires (visible in logs); run eventually completes or fails cleanly after max attempts
- [ ] Confirm `conn.logout()` is called — visible in `LOG_LEVEL=debug` output
- [ ] Trigger DML failure intentionally (e.g., duplicate external ID); confirm `log.error` is used, not `log.info`

#### Rollback Plan
Each task is a small isolated change. Revert individual files with `git checkout`. The retry wrapper is additive — removing it (reverting `lib/utils/retry.js` and its call sites) restores previous single-attempt behavior.

---

### Step 4: Extend

#### Goal
Unlock testability, pluggability, and safer advanced features. After this step, generators are registered rather than hard-coded, filter expressions are safe, and config schemas are validated at load time.

#### Risk Level
Low–Medium — generator registry is additive; filter evaluator replacement is a potential breaking change for existing `expr` predicates.

#### Depends On
Step 3 (all hardening in place; refactored structure stable).

#### Tasks

**Generator registry:**
- [ ] Implement `lib/pipeline/generators.js` with `registerGenerator()` / `runGenerator()` — 1 hr
- [ ] Update `services/generators.js` to register generators via `registerGenerator()` at startup — 30 min
- [ ] Update `lib/pipeline/orchestrator.js` to call `runGenerator()` from registry — 30 min

**Dependency injection for validators:**
- [ ] Update `lib/validators/matchkeys.js` to receive `envConfig` as an argument rather than reading `process.env.AUTO_CREATE_MATCH_KEYS` directly — 30 min
- [ ] Update all callers of `validateMatchKeysFromSnapshots` to pass `envConfig` — 30 min

**Safe filter evaluator:**
- [ ] Audit all existing `expr` values in config files — document which JS syntax is used — 1 hr
- [ ] Install `expr-eval` or `filtrex` — 15 min
- [ ] Replace `new Function()` in `lib/filters.js` with safe evaluator — 1 hr
- [ ] Run each existing `expr` through the new evaluator; confirm equivalent results — 1 hr

**Config schema validation (stretch goal):**
- [ ] Add JSON Schema for `pipeline.json` structure — new `lib/validators/configschema.js` — 2 hrs
- [ ] Add JSON Schema for object mapping config structure — 2 hrs
- [ ] Validate at load time in `lib/config/pipeline.js` and `lib/config/step-config.js` — 1 hr

#### Verification
- [ ] Register a custom generator via `registerGenerator('myGen', fn)` in a test script; run pipeline; confirm it executes
- [ ] Confirm existing BKAI generators produce identical output after registry migration
- [ ] Write a filter with `expr: "Amount > 5000"` — confirm it works without `new Function` and produces correct results
- [ ] Provide a malformed `pipeline.json` (missing required field); confirm schema error is clear and fires before any Salesforce call

#### Rollback Plan
Generator registry is additive — reverting `registerGenerator` calls and restoring the direct object map in `services/generators.js` restores previous behavior. Filter evaluator replacement should be done on a feature branch with the existing `expr` audit complete before merging; revert the branch if any predicate produces different results.

---

## Total Effort Estimate

| Priority Tier | Tasks | Estimated Effort |
|---|---|---|
| **P1** (Steps 1 + partial Step 2) | Bug fixes, decompile, env config, orchestrator extraction | ~6 days |
| **P2** (Remainder of Steps 2 + 3) | Full refactor, hardening, retry, dual logger | ~6 days |
| **P3** (Step 4) | Generator registry, safe filter, config schema | ~4 days |
| **Total** | | **~16 working days** |

P1 items deliver the highest ROI: they fix active crashes, unlock all future maintenance work (by decompiling the minified files), and provide a clear startup error experience. P2 and P3 items can be batched into normal sprint cycles.
