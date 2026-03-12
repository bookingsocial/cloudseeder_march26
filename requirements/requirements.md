# CloudSeeder — Requirements

## 1. Overview

CloudSeeder is a Node.js CLI tool that loads declaratively-configured seed data into Salesforce orgs. It reads JSON pipeline definitions, applies field mappings and data transformations, resolves parent-child foreign key references, and writes records to Salesforce using the REST, Composite, or Bulk API 2.0. The primary purpose is repeatable, idempotent seeding of Salesforce environments for demos, testing, or initial data population.

---

## 2. Functional Requirements

### Pipeline Execution

**FR-001** — The system shall read a `pipeline.json` file that defines an ordered list of steps, each targeting a specific Salesforce object.

**FR-002** — Each pipeline step shall specify: `object`, `dataFile`, `dataKey`, `mode`, `configFile`, and optionally `dependsOn`, `filter`, and `generator`.

**FR-003** — The system shall topologically sort pipeline steps by their `dependsOn` declarations before execution, preserving original JSON order among steps at the same dependency depth.

**FR-004** — The system shall detect cyclic `dependsOn` declarations and fall back to original step order with a warning rather than crashing.

**FR-005** — The system shall accumulate a per-object `idMap` (external key → Salesforce Id) after each step, making those IDs available to all subsequent steps.

**FR-006** — The system shall support a `dryRun` mode (via `DRY_RUN` env var or `pipeline.json`'s `dryRun` field) that processes and transforms records but does not write to Salesforce.

**FR-007** — The system shall validate that each step has `object`, `dataFile`, and `configFile` fields; missing fields shall cause an immediate fatal error.

### Data Loading

**FR-008** — The system shall load seed data from JSON or JSON5 files (comments and trailing commas permitted) via `step.dataFile` and `step.dataKey`.

**FR-009** — The system shall support two step modes: `direct` (use seed records as-is after transforms) and `generate` (produce records via a named generator function).

**FR-010** — The system shall apply an optional declarative `filter` to seed records before processing. If no filter is specified, all records in the data key are used.

**FR-011** — The system shall support the following filter predicates: `exists`, `missing`, `equals`, `neq`, `in`, `nin`, `regex`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `length`, `all` (AND), `any` (OR), `not`, and `expr` (inline JS expression).

**FR-012** — The system shall apply field shaping to each record: rename fields via `shape.fieldMap`, apply default values via `shape.defaults`, and drop fields via `shape.removeFields`.

**FR-013** — The system shall apply pre-transforms before reference resolution and post-transforms after. Supported transform operations: `assign`, `copy`, `rename`, `remove`, `coalesce`, `concat`.

**FR-014** — The system shall resolve declarative foreign-key references (`references` array in mapping config) by looking up external keys in accumulated `idMaps` and writing the resolved Salesforce Id to the target field.

**FR-015** — Reference resolution shall support: string `refKey`, array `refKey` (first non-empty wins), template `refKey` (`${fieldName}` syntax), and legacy `from: "idMaps.<Object>['${key}']"` syntax.

**FR-016** — Reference resolution shall infer the target Salesforce object from the lookup field name (e.g., `AccountId` → `Account`, `ParentId` → current object) unless `refObject` is explicitly provided.

**FR-017** — Each reference entry shall support an `onMissing` policy: `"error"` (default, throws), `"null"` (sets field to null), or `"skip"` (omits field).

**FR-018** — The system shall interpolate `${constants.<path>}` placeholders in mapping configs and seed record values using the loaded constants object.

**FR-019** — The system shall enforce required fields (`validate.requiredFields`) on each record after transforms and reference resolution; any missing field shall throw a fatal error.

**FR-020** — The system shall enforce client-side uniqueness (`validate.uniqueBy`) across all records in a step; duplicate keys shall throw a fatal error.

**FR-021** — The system shall split processed records into batches of `strategy.batchSize` (default: 200) before committing.

### Salesforce API

**FR-022** — The system shall support three Salesforce API strategies selectable per step via `strategy.api`: `rest`, `composite`, and `bulk`.

**FR-023** — The REST strategy (`commitREST`) shall support `insert` and `upsert` operations via jsforce's `sobject().insert()` and `sobject().upsert()`. After upsert, it shall verify committed records with a SOQL `$in` query.

**FR-024** — The Composite strategy (`commitComposite`) shall fall back to per-record REST calls (true single-call composite is not implemented). It supports `insert` and `upsert`.

**FR-025** — The Bulk strategy (`commitBulk`) shall use jsforce's Bulk API 2.0 (`conn.bulk2.loadAndWaitForResults`) and support `insert` and `upsert`. Poll timeout defaults to 10 minutes; poll interval defaults to 2 seconds, both configurable via `strategy.pollTimeoutMs` and `strategy.pollIntervalMs`.

**FR-026** — All commit strategies shall return a normalized result with `created`, `updated`, and `failures` arrays, plus `processedRecords` verified from the org.

**FR-027** — The Bulk strategy shall throw if the operation is not `insert` or `upsert`.

### Metadata Validation

**FR-028** — The system shall snapshot Salesforce object `describe` metadata for all objects in the pipeline and cache results under `meta-data/<ORG_ID>/` on the local filesystem.

**FR-029** — Metadata snapshots shall be refreshed when `REFRESH_METADATA=true` is set; otherwise the cached snapshot is used.

**FR-030** — The system shall prune fields from records that do not exist in the org or are not writable for the given operation (insert/upsert), before commit.

**FR-031** — The system shall validate that the mapping's `identify.matchKey` field exists in the org's object describe. If it does not exist and `AUTO_CREATE_MATCH_KEYS=true`, the system shall create the field (Text 255, unique, external ID) via the metadata API.

**FR-032** — When auto-creating a match key field, the system shall grant field-level security via a Permission Set, assign the Permission Set to the running user, and re-snapshot the object's metadata.

**FR-033** — If any pipeline object's metadata is unavailable (e.g., object does not exist in org), the system shall abort with a fatal error before executing any steps.

### Configuration System

**FR-034** — The system shall load `pipeline.json` from `config/pipeline.json` with an optional overlay from `config/env/<ENV_NAME>/pipeline.json`.

**FR-035** — The system shall load `constants.json` from `config/constants.json` with an optional overlay from `config/env/<ENV_NAME>/constants.json`. Both files are optional.

**FR-036** — Per-step mapping configs shall be loaded with a four-level merge: base (`config/base/<Object>.json`), env (`config/env/<ENV_NAME>/<Object>.json`), step (`step.configFile`), and inline (`step.configInline`). Higher levels override lower ones.

**FR-037** — All config files shall be loaded with JSON5 support (permissive parser: comments, trailing commas). Step mapping configs use standard `JSON.parse`.

**FR-038** — Loaded step configs shall be memoized in a process-level cache keyed by object name, resolved file paths, env name, and a hash of any inline overrides.

### Generators

**FR-039** — The system shall dispatch `mode: "generate"` steps to named generator functions registered in `services/generators.js`.

**FR-040** — The system shall provide three built-in generators: `generateExpertLocationJunctions`, `generateShiftPatternsPerLocation`, and `generateChildLocationsWithHierarchy`.

**FR-041** — Generators shall receive the full raw data object (as loaded from `step.dataFile`) and the accumulated `idMaps` from all prior steps; they shall return a plain array of records.

### Authentication

**FR-042** — The system shall authenticate to Salesforce using username/password via jsforce `Connection.login()`. Login URL, username, and password are read from environment variables.

### Logging

**FR-043** — The system shall write a timestamped log file per run to `logs/run-YYYYMMDD_HHMMSSZ.log` containing start/stop events, per-step summaries, and a final JSON run report.

**FR-044** — The system shall write a final JSON run report including: `env`, `dryRun`, `startedAt`, `finishedAt`, `totalElapsedMs`, per-step stats (`attempted`, `ok`, `errors`, `elapsedMs`), and aggregate totals.

**FR-045** — The system shall emit console log output with ISO timestamps and an object/module tag on every line.

---

## 3. Non-Functional Requirements

**NFR-001 — Idempotency**: Upsert operations with external ID fields ensure that re-running a pipeline on an org that already contains the data updates existing records rather than creating duplicates.

**NFR-002 — Metadata caching**: Object describe calls are cached to disk per org ID and reused across runs to minimize API calls. Concurrency during snapshot is limited to 2 parallel requests to avoid rate limits.

**NFR-003 — Batch size**: Records are chunked into configurable batches (default 200) before committing, ensuring compatibility with Salesforce API governor limits.

**NFR-004 — Bulk polling**: Bulk API 2.0 jobs are polled with a 2-second interval and a 10-minute timeout by default, both overridable per step via `strategy.pollTimeoutMs` and `strategy.pollIntervalMs`.

**NFR-005 — Error isolation**: Commit failures are logged per-record with messages; execution continues for subsequent batches. Fatal errors (missing config, snapshot failure) abort the entire run.

**NFR-006 — Log verbosity control**: Console log level is controlled via `LOG_LEVEL` environment variable (values: `error`, `warn`, `info`, `debug`; default: `info`).

**NFR-007 — Field pruning logging**: Setting `LOG_PRUNE=true` logs the fields removed during metadata pruning for the first two records of each step.

**NFR-008 — Reference debugging**: Setting `DEBUG_REFS=true` emits detailed reference resolution traces to console debug output.

**NFR-009 — ESM module format**: The project uses native ES modules (`"type": "module"` in `package.json`). All files use `import`/`export` syntax.

**NFR-010 — No build step required**: The project runs directly with `node scripts/runLoad.js`; no TypeScript compilation or bundling is needed.

---

## 4. User Personas

### Demo Engineer / Solutions Engineer
Configures and runs CloudSeeder to populate a Salesforce demo org with realistic sample data before a customer presentation. Defines seed JSON files, writes mapping configs, and runs the CLI. Expects reliable idempotency so they can re-run without duplicating records.

### Salesforce Developer / Admin
Uses CloudSeeder in a development org to seed test data matching production schemas. Relies on external ID field auto-creation and FLS grant to avoid manual field setup. May customize generators for object hierarchies specific to their data model.

### QA / Test Automation Engineer
Integrates CloudSeeder into a CI pipeline to reset a scratch org to a known data state before running automated tests. Uses `DRY_RUN` mode to validate pipeline config without incurring API calls.

---

## 5. Out of Scope

The following items are referenced in comments or structure but are **not fully implemented** in the current codebase:

- **True Composite API**: `commitComposite` falls back to sequential per-record REST calls. A single-request Salesforce Composite API call is noted in a comment but not implemented.
- **`update` operation**: The strategy `operation` field accepts `"update"` conceptually, but `commitBulk` only implements `insert` and `upsert`; `commitREST` only branches on `upsert` vs. everything else (which goes through `insert`).
- **CLI argument parsing**: There is no argument parser (e.g., `yargs`, `commander`). All configuration is via environment variables and config files.
- **Environment-specific config overlays**: The overlay directories (`config/base/`, `config/env/<ENV>/`) are structurally supported but no overlay files are present in the repository.
- **`console.time` step timing**: `log.stepStart()` and `log.stepEnd()` stub out `console.time`/`console.timeEnd` calls (commented out).
- **`LOG_PRUNE` field diff logging**: The `LOG_PRUNE=true` code path references an undefined variable `work` and would throw a `ReferenceError` if enabled.
