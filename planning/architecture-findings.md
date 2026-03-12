# Architecture Findings — CloudSeeder

**Review Date:** 2026-03-12
**Source:** [improvementplan_20260312_0156.md](improvementplan_20260312_0156.md)

---

## Summary Table

| ID | Problem | Location | Severity | Priority | Status |
|---|---|---|---|---|---|
| ARCH-001 | Minified source files in repository | `lib/metadata.min.js`, `lib/utils.min.js` | High | P1 | Open |
| ARCH-002 | God file — `scripts/runLoad.js` | `scripts/runLoad.js` | High | P1 | Open |
| ARCH-003 | Latent `ReferenceError` on `LOG_PRUNE=true` | `lib/loader.js:119–122` | High | P1 | Open |
| ARCH-004 | `commitComposite` returns a different shape | `lib/sf.js:124–144` | High | P1 | Open |
| ARCH-005 | `new Function()` eval-equivalent in filter `expr` | `lib/filters.js:37–38` | High | P3 | Open |
| ARCH-006 | Scattered environment variable access | 8 files (see §1.5) | Medium | P1 | Open |
| ARCH-007 | Duplicated `deepMerge` implementations | `lib/config/utils.js`, `lib/config/step-config.js` | Medium | P2 | Open |
| ARCH-008 | Mixed JSON parsers across config layer | `step-config.js`, `validatematchkeys.js` | Medium | P2 | Open |
| ARCH-009 | Module-level side effect in `lib/auth.js` | `lib/auth.js:3` | Medium | P2 | Open |
| ARCH-010 | No pre-flight credential validation | `lib/auth.js`, `scripts/runLoad.js` | Medium | P1 | Open |
| ARCH-011 | No retry or backoff on external API calls | `lib/auth.js`, `lib/sf.js`, `lib/metadata.min.js` | Medium | P2 | Open |
| ARCH-012 | `runcontext.js` process-level mutable singleton | `lib/runcontext.js` | Medium | P3 | Open |
| ARCH-013 | Hard-coded metadata snapshot concurrency | `scripts/runLoad.js:159` | Low | P3 | Open |
| ARCH-014 | Dual logging pattern requires manual sync | Throughout `scripts/runLoad.js` | Low | P2 | Open |
| ARCH-015 | Generator system is domain-specific and not pluggable | `services/generators.js` | Low | P3 | Open |
| ARCH-016 | `validateBatch` warns but does not block | `lib/loader.js:126`, `lib/metadata.min.js` | Low | P3 | Open |
| ARCH-017 | `console.warn` used instead of `log` in `commitBulk` | `lib/sf.js:316` | Low | P1 | Open |
| ARCH-018 | No jsforce connection cleanup | `scripts/runLoad.js:main()` | Low | P3 | Open |

---

## Detailed Findings

---

#### ARCH-001: Minified Source Files in Repository

- **Location:** `lib/metadata.min.js`, `lib/utils.min.js`
- **Severity:** High
- **Priority:** P1
- **Status:** Open
- **Description:** Two core library files are stored as minified JavaScript in the repository — production-minified output shipped as source code. No whitespace, no comments, single-character identifiers.
- **Impact:** Cannot be read, debugged, or modified without first decompiling. Any bug requires reverse engineering. IDE tooling (jump to definition, refactor, hover docs) is completely broken for these modules. Code review is impossible. All other refactoring work is blocked until these are restored.
- **Linked Recommendation:** [REC-001](recommendations.md#rec-001-decompile-and-restore-minified-source-files)

---

#### ARCH-002: God File — `scripts/runLoad.js`

- **Location:** `scripts/runLoad.js`
- **Severity:** High
- **Priority:** P1
- **Status:** Open
- **Description:** The entry point handles at least seven distinct responsibilities in a single 329-line `main()` function: authentication, configuration loading, metadata snapshotting, topological sort, step execution loop, generator dispatch, idMap accumulation, and dual-channel logging. No internal abstractions exist.
- **Impact:** Any change requires understanding the entire file. Cannot be unit-tested without mocking six external modules. Adding a new lifecycle phase (e.g., pre-run hooks) requires modifying the already-complex `main()`. Cyclomatic complexity is high.
- **Linked Recommendation:** [REC-002](recommendations.md#rec-002-extract-pipeline-orchestrator-from-entry-point)

---

#### ARCH-003: Latent `ReferenceError` — `LOG_PRUNE=true` Code Path

- **Location:** `lib/loader.js:119–122`
- **Severity:** High
- **Priority:** P1
- **Status:** Open
- **Description:** The `LOG_PRUNE` feature references `work[i]` in its log callback, but `work` does not exist in `insertAndMap()`. It was almost certainly the prior name for `transformedRecord`. Enabling `LOG_PRUNE=true` triggers a `ReferenceError` at runtime.
- **Impact:** A documented environment variable silently crashes the pipeline when enabled. Any developer troubleshooting field pruning encounters an unrelated crash instead.
- **Linked Recommendation:** [REC-004](recommendations.md#rec-004-fix-log_prune-referenceerror)

---

#### ARCH-004: `commitComposite` Returns a Different Shape

- **Location:** `lib/sf.js:124–144`
- **Severity:** High
- **Priority:** P1
- **Status:** Open
- **Description:** `commitREST` and `commitBulk` return a normalized `{ created, updated, failures, processedRecords }` object. `commitComposite` returns a raw `results[]` array. The caller in `lib/loader.js:159` unconditionally calls `results.failures.length`, which throws a `TypeError` whenever `strategy.api` is `"composite"`.
- **Impact:** The `composite` API option is advertised in mapping config schema and docs but is silently broken. Any user who sets `"api": "composite"` gets a crash.
- **Linked Recommendation:** [REC-003](recommendations.md#rec-003-fix-commitcomposite-return-shape)

---

#### ARCH-005: `new Function()` Eval-Equivalent in Filter `expr` Predicate

- **Location:** `lib/filters.js:37–38`
- **Severity:** High (security) / Medium (operational)
- **Priority:** P3
- **Status:** Open
- **Description:** The `expr` filter predicate builds a function using `new Function("rec", "ctx", ...)`, which is equivalent to `eval`. Any string reaching this code path is executed as JavaScript. If expression throws, the filter silently returns `false`, potentially excluding all records with no visible error (warning only fires if `DEBUG_FILTERS` is set).
- **Impact:** Security risk if configs are ever externally sourced. Silent data loss if expression has a bug — entire record set may be excluded with no log output.
- **Linked Recommendation:** [REC-013](recommendations.md#rec-013-replace-expr-predicate-new-function-with-safe-evaluator)

---

#### ARCH-006: Scattered Environment Variable Access

- **Location:** 8 different files: `lib/auth.js`, `scripts/runLoad.js`, `lib/config/pipeline.js`, `lib/config/constants.js`, `lib/config/step-config.js`, `lib/validators/validatematchkeys.js`, `lib/utils/logger.js`, `lib/loader.js`
- **Severity:** Medium
- **Priority:** P1
- **Status:** Open
- **Description:** `process.env` is read directly at call sites in at least 8 modules. No central env config object or startup validation exists. The orchestrator cannot know what env vars are required by each module without reading all source code.
- **Impact:** Adding a new env var requires touching 3+ files. A typo in `SF_USERNAME` is only discovered at Salesforce login with a generic error. No single place to document or enforce required vs. optional vars.
- **Linked Recommendation:** [REC-005](recommendations.md#rec-005-create-a-centralized-environment-config-module)

---

#### ARCH-007: Duplicated `deepMerge` Implementations

- **Location:** `lib/config/utils.js:9–21` (mutating), `lib/config/step-config.js:19–37` (non-mutating)
- **Severity:** Medium
- **Priority:** P2
- **Status:** Open
- **Description:** Two separate `deepMerge` implementations with subtly different semantics. `lib/config/utils.js` mutates `target` in-place and does not use `structuredClone`. `lib/config/step-config.js` is non-mutating and uses `structuredClone`. The mutation in `utils.js` is currently safe (first arg is always `{}`) but is a footgun.
- **Impact:** Two implementations to maintain; mutation footgun; behavioral inconsistency between config layers. Any future caller that passes a reused reference gets silent shared-state corruption.
- **Linked Recommendation:** [REC-008](recommendations.md#rec-008-consolidate-deepmerge-into-single-shared-implementation)

---

#### ARCH-008: Mixed JSON Parsers Across Config Layer

- **Location:** `lib/config/utils.js` (JSON5), `lib/config/step-config.js` (JSON.parse), `lib/validators/validatematchkeys.js` (JSON.parse)
- **Severity:** Medium
- **Priority:** P2
- **Status:** Open
- **Description:** The config subsystem uses JSON5 for `pipeline.json` and `constants.json` but switches to standard `JSON.parse` for object mapping configs. Comments and trailing commas work in `pipeline.json` but silently fail (parse error) in mapping files like `Account.json`.
- **Impact:** Inconsistent developer experience. A comment in `Contact.json` causes a parse error; the same comment in `pipeline.json` is fine. Confusing for contributors who expect uniform JSON5 support.
- **Linked Recommendation:** [REC-006](recommendations.md#rec-006-unify-json-parser-across-config-layer)

---

#### ARCH-009: Module-Level Side Effect in `lib/auth.js`

- **Location:** `lib/auth.js:3`
- **Severity:** Medium
- **Priority:** P2
- **Status:** Open
- **Description:** `dotenv.config()` is called at the top level of `auth.js`, meaning `.env` is loaded as a side effect of importing the module — not when `getConnection()` is called. Import order matters implicitly.
- **Impact:** In tests, env var mocking must account for this implicit side effect. If import order changes or the module is used in a different context, the side effect fires unexpectedly. Invisible order-of-import dependency.
- **Linked Recommendation:** [REC-010](recommendations.md#rec-010-move-dotenvconfig-to-entry-point)

---

#### ARCH-010: No Pre-flight Credential Validation

- **Location:** `lib/auth.js`, `scripts/runLoad.js`
- **Severity:** Medium
- **Priority:** P1
- **Status:** Open
- **Description:** `SF_LOGIN_URL`, `SF_USERNAME`, and `SF_PASSWORD` are passed directly to jsforce with no presence check. Missing or empty values produce generic jsforce errors with no indication of which env var is wrong.
- **Impact:** Poor developer experience on first run or misconfiguration. Debug time wasted on generic API errors ("INVALID_LOGIN: Invalid username, password, security token") rather than a clear "Missing required env var: SF_USERNAME".
- **Linked Recommendation:** [REC-005](recommendations.md#rec-005-create-a-centralized-environment-config-module)

---

#### ARCH-011: No Retry or Backoff on External API Calls

- **Location:** `lib/auth.js`, `lib/sf.js`, `lib/metadata.min.js`
- **Severity:** Medium
- **Priority:** P2
- **Status:** Open
- **Description:** All Salesforce API calls (login, insert, upsert, bulk load, describe) are single-attempt with no retry logic. Transient network errors, Salesforce timeouts, or API concurrency limits cause immediate run failure.
- **Impact:** A 5-second network hiccup during a 10-minute bulk load aborts the entire run. Users must restart from scratch. Particularly impactful for large pipelines where retrying failed batches would be sufficient.
- **Linked Recommendation:** [REC-009](recommendations.md#rec-009-add-retry-wrapper-for-external-api-calls)

---

#### ARCH-012: `runcontext.js` Process-Level Mutable Singleton

- **Location:** `lib/runcontext.js`
- **Severity:** Medium
- **Priority:** P3
- **Status:** Open
- **Description:** The org ID is stored as module-level mutable state (`let orgId = null`). The module provides `resetOrgId()` for testing, but this pattern carries implicit global state that survives across multiple hypothetical pipeline runs in a single process.
- **Impact:** Low risk in current architecture (one run per process), but untestable without explicit reset. Tests that forget to call `resetOrgId()` bleed state into subsequent test cases.
- **Linked Recommendation:** [REC-005](recommendations.md#rec-005-create-a-centralized-environment-config-module) (addressed as part of Step 4 injected dependency)

---

#### ARCH-013: Hard-Coded Metadata Snapshot Concurrency

- **Location:** `scripts/runLoad.js:159`
- **Severity:** Low
- **Priority:** P3
- **Status:** Open
- **Description:** Metadata snapshot concurrency is hard-coded to `2` at the call site in `main()`. The inline comment says "raise carefully if needed" but there is no env var or config option to do so without editing source code.
- **Impact:** Users with large pipelines who need faster snapshots cannot tune this without modifying source.
- **Linked Recommendation:** [REC-011](recommendations.md#rec-011-add-configurable-metadata-snapshot-concurrency)

---

#### ARCH-014: Dual Logging Pattern Requires Manual Sync

- **Location:** Throughout `scripts/runLoad.js`
- **Severity:** Low
- **Priority:** P2
- **Status:** Open
- **Description:** Every log statement in `main()` is written twice — once to `log` (console) and once to `fileLog` (run log). The dual-write is manually maintained by copy-paste. If one side is updated, the other is often missed.
- **Impact:** Maintenance burden; potential console/file log divergence; scales poorly as more log points are added.
- **Linked Recommendation:** [REC-007](recommendations.md#rec-007-create-a-unified-dual-logger)

---

#### ARCH-015: Generator System Is Domain-Specific and Not Pluggable

- **Location:** `services/generators.js`
- **Severity:** Low
- **Priority:** P3
- **Status:** Open
- **Description:** All three built-in generators are specific to the BKAI domain (`BKAI__Expert__c`, `BKAI__Location__c`, `BKAI__Shift_Pattern__c`). No mechanism exists to register generators without editing this file. No documentation on how to add a new one.
- **Impact:** Low reusability for other Salesforce domains. Users must edit library code to add generators rather than using a plugin/registry API.
- **Linked Recommendation:** [REC-013](recommendations.md#rec-013-replace-expr-predicate-new-function-with-safe-evaluator) *(generator registry is Step 4a in the roadmap)*

---

#### ARCH-016: `validateBatch` Warns But Does Not Block

- **Location:** `lib/loader.js:126`, `lib/metadata.min.js` (minified)
- **Severity:** Low
- **Priority:** P3
- **Status:** Open
- **Description:** After `pruneRecordFields`, `validateBatch` is called but only emits warnings — it does not throw or signal validation failure, and its return value is not checked.
- **Impact:** Schema validation errors are invisible unless `LOG_LEVEL=debug`. Records with bad fields proceed to the API and get rejected there, making the metadata validation layer ineffective as a gate.
- **Linked Recommendation:** [REC-012](recommendations.md#rec-012-make-validatebatch-throw-on-invalid-fields)

---

#### ARCH-017: `console.warn` Used Instead of `log` in `commitBulk`

- **Location:** `lib/sf.js:316`
- **Severity:** Low
- **Priority:** P1
- **Status:** Open
- **Description:** The verification query failure handler in `commitBulk` uses `console.warn(...)` directly instead of `log.warn(...)`. This bypasses `LOG_LEVEL` gating and the standard timestamp/tag format.
- **Impact:** This message is always visible regardless of `LOG_LEVEL`; it does not appear in the run log file; it breaks the consistent log format.
- **Linked Recommendation:** *(inline fix — addressed as task 1c in [migration-roadmap.md](migration-roadmap.md#step-1-foundation))*

---

#### ARCH-018: No jsforce Connection Cleanup

- **Location:** `scripts/runLoad.js:main()`
- **Severity:** Low
- **Priority:** P3
- **Status:** Open
- **Description:** The jsforce connection is created in `main()` but never explicitly logged out or closed when the run completes or fails. There is no `conn.logout()` in either the success path or the error handler.
- **Impact:** Minor resource leak; session lingers on Salesforce until server-side timeout. Adds unnecessary active sessions, especially during repeated test runs.
- **Linked Recommendation:** *(inline fix — addressed as task 3e in [migration-roadmap.md](migration-roadmap.md#step-3-harden))*
