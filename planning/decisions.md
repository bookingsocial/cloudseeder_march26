# Architectural Decision Log — CloudSeeder

This is a running log of significant architectural decisions. Add a new entry
before starting any non-trivial architectural change. Update `Status` when
a decision is superseded or deprecated.

---

#### ADR-001: Restore Minified Source Files Before Any Other Refactoring

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** Two core library files (`lib/metadata.min.js`, `lib/utils.min.js`) are stored as minified JavaScript. All proposed refactoring work depends on being able to read, split, and reorganize these modules. Attempting Step 2 (Refactor) without readable source would require working against compressed, single-character-variable code.
- **Decision:** Decompile both minified files to readable, JSDoc-annotated source as the very first task (Step 1e/1f in the roadmap). No pipeline extraction or module reorganization work will begin until this is complete.
- **Consequences:** Unlocks all future maintenance. Introduces a 1–2 day decompile + review phase. Risk: decompiler may introduce subtle behavioral differences — mitigated by running full pipeline integration tests before and after.
- **Alternatives Considered:**
  - *Rewrite from scratch:* rejected — too much risk of behavioral divergence without understanding what the originals do.
  - *Work around the minified files:* rejected — impossible to split `lib/utils.min.js` into `lib/transform/` modules without reading the source.

---

#### ADR-002: Centralize All Environment Variable Access in `lib/config/env.js`

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** `process.env` is currently read in 8 different modules. There is no startup validation — a missing `SF_USERNAME` is only discovered when jsforce throws a generic login error. Contributing to or debugging the system requires reading all 8 files to understand the full set of required env vars.
- **Decision:** Create `lib/config/env.js` as the single point of entry for all environment variable reads. It validates required vars at startup and exports a typed config object. All other modules receive config as function arguments, not by reading `process.env` directly.
- **Consequences:** Easier: startup errors are clear and fast. Adding a new env var requires touching only one file. Harder: all existing modules need their signatures updated to accept config arguments instead of reading env directly (a one-time migration cost).
- **Alternatives Considered:**
  - *Validate in each module:* rejected — doesn't solve the discoverability problem; still 8 places to look.
  - *Use a third-party config library (e.g., `env-var`, `zod`):* considered but deferred — the current surface is small enough that a hand-written validator is sufficient and adds no dependency.

---

#### ADR-003: Use Non-Mutating `deepMerge` as the Single Canonical Implementation

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** Two implementations of `deepMerge` exist with different mutation semantics. The `lib/config/utils.js` version mutates its first argument in-place. The `lib/config/step-config.js` version is non-mutating and uses `structuredClone`. The mutation is currently safe (first arg is always `{}`), but is a footgun for future callers.
- **Decision:** Adopt the non-mutating implementation as canonical in `lib/config/utils.js`. Remove the duplicate from `lib/config/step-config.js`. All callers use variadic pattern `sources.reduce(deepMerge, {})`.
- **Consequences:** Eliminates the mutation footgun. Slightly higher memory cost (clones objects). No behavioral difference for existing callers since they all pass `{}` as the first argument.
- **Alternatives Considered:**
  - *Keep the mutating version:* rejected — mutation of shared objects is a well-known source of hard-to-debug bugs; the non-mutating version is safer.
  - *Use lodash `_.merge`:* rejected — adds a heavyweight dependency for a utility that is simple to implement correctly.

---

#### ADR-004: Use JSON5 as the Uniform Config Parser

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** `pipeline.json` and `constants.json` are parsed with JSON5 (supports comments, trailing commas). Object mapping configs (`Account.json`, etc.) are parsed with standard `JSON.parse`. This means comments work in pipeline config but fail silently (parse error) in mapping files. Contributors expect uniform behavior.
- **Decision:** Use JSON5 everywhere config files are read. Replace `JSON.parse` in `lib/config/step-config.js` and `lib/validators/validatematchkeys.js` with the shared `readJSON` utility from `lib/config/utils.js`.
- **Consequences:** Consistent developer experience across all config files. JSON5 is a strict superset of JSON — no existing files will break. Comments and trailing commas now work everywhere.
- **Alternatives Considered:**
  - *Switch everything to standard JSON:* rejected — would require removing comments from `pipeline.json` and `constants.json`, degrading the existing experience.
  - *Document the inconsistency:* rejected — documentation does not prevent the confusion; fixing it does.

---

#### ADR-005: Normalize All Commit Strategy Return Shapes

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** The three commit strategies (`commitREST`, `commitComposite`, `commitBulk`) are meant to be interchangeable (Strategy pattern). However, `commitComposite` returns a raw array while the others return `{ created, updated, failures, processedRecords }`. This silently breaks any caller that uses `composite` mode, which is an advertised feature.
- **Decision:** Update `commitComposite` to return the same normalized shape. This is both a bug fix and a formal adoption of the Strategy interface contract: all strategies must return `CommitResult = { operation, created[], updated[], failures[], processedRecords[] }`.
- **Consequences:** Fixes the active crash for `"api": "composite"` users. Establishes a formal interface that future commit strategies must conform to.
- **Alternatives Considered:**
  - *Add a normalization shim in the caller:* rejected — band-aid that doesn't fix the broken strategy; future callers would also need the shim.
  - *Remove `composite` mode:* rejected — it is an advertised feature; fixing it is lower effort than removing and re-documenting it.

---

#### ADR-006: Use Exponential Backoff Retry for Transient API Failures Only

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** All Salesforce API calls are single-attempt. Transient failures (network resets, rate limit responses) abort the entire run. For long bulk-load pipelines, this is a significant operational cost. However, retrying non-idempotent operations (insert without external ID) would cause duplicate records.
- **Decision:** Create a `withRetry(fn, opts)` wrapper with exponential backoff. Apply it only to operations that are safe to retry: login, bulk load (which uses `upsert`/external IDs), and describe calls. Use a `retryOn` predicate to limit retries to known transient error codes (`ECONNRESET`, `REQUEST_LIMIT_EXCEEDED`). Do NOT wrap metadata creation, permission set operations, or plain inserts.
- **Consequences:** Improved resilience for long-running pipelines. Risk: incorrect `retryOn` predicate could cause duplicate data. Mitigate by defaulting `retryOn` to a strict allowlist of known-safe error codes.
- **Alternatives Considered:**
  - *Retry all failures:* rejected — would cause duplicate inserts on non-idempotent operations.
  - *Use a third-party retry library (e.g., `p-retry`):* acceptable alternative, but the required surface is small enough that a hand-written wrapper avoids the dependency and makes the retry semantics explicit.

---

#### ADR-007: Replace `new Function()` in Filter `expr` with a Safe Expression Evaluator

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** The `expr` filter predicate in `lib/filters.js` uses `new Function()` to evaluate arbitrary JavaScript expressions, which is equivalent to `eval`. While configs are currently developer-authored, this is a code execution vulnerability if filter specs ever come from an external or untrusted source. Additionally, expression errors are silently swallowed (returns `false`), causing potential data loss.
- **Decision:** Replace `new Function()` with a safe expression evaluator library (`filtrex` or `expr-eval`). The evaluator supports field access, comparison operators, and boolean combinators — sufficient for all current use cases — without permitting arbitrary code execution. Deferred to P3 (Step 4) since configs are currently internal.
- **Consequences:** Eliminates the security risk. May be a breaking change if any existing `expr` predicates use JS-only syntax not supported by the evaluator. Requires an audit of all existing filter configs before switching.
- **Alternatives Considered:**
  - *Keep `new Function()` and add a config-source restriction:* rejected — doesn't eliminate the risk; relies on operational guarantees that are hard to enforce.
  - *Allow only a predefined set of filter operators (no expr at all):* considered but rejected — the `expr` feature is the most flexible filter type and is in active use.

---

#### ADR-008: Migrate `scripts/runLoad.js` to a Thin Entry Point via Orchestrator Extraction

- **Date:** 2026-03-12
- **Status:** Proposed
- **Context:** `scripts/runLoad.js` currently contains seven distinct responsibilities in a single 329-line `main()` function: authentication, config loading, metadata snapshotting, topological sort, step execution loop, generator dispatch, idMap accumulation, and dual-channel logging. This makes the file untestable as a unit and makes adding new lifecycle phases high-risk.
- **Decision:** Extract the step execution loop into `lib/pipeline/orchestrator.js`. Extract `topoSortSteps` to `lib/pipeline/toposort.js`, generator dispatch to `lib/pipeline/generators.js`, and data file loading to `lib/pipeline/dataloader.js`. The entry point becomes responsible only for: dotenv init, calling auth, loading config, calling `runPipeline()`, and catching the top-level error.
- **Consequences:** `main()` becomes ~20 lines and is trivially readable. Each extracted module is independently testable. Adding new lifecycle phases (e.g., pre-run hooks, post-run reports) requires modifying only `orchestrator.js`.
- **Alternatives Considered:**
  - *Break `main()` into private helper functions in the same file:* rejected — improves readability but doesn't improve testability or enforce module boundaries.
  - *Full rewrite with a class-based orchestrator:* rejected — over-engineering; plain functions with clear signatures achieve the same result with less ceremony.
