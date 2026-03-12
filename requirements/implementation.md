# CloudSeeder — Implementation Reference

## 1. Architecture Overview

### Folder Structure

```
cloudseeder/
├── scripts/
│   └── runLoad.js              # CLI entry point and orchestrator
├── lib/
│   ├── auth.js                 # Salesforce authentication (jsforce)
│   ├── loader.js               # Per-step transform + commit pipeline
│   ├── sf.js                   # Salesforce commit strategies (REST/Composite/Bulk)
│   ├── filters.js              # Declarative record filter engine
│   ├── runcontext.js           # Runtime singleton: org ID
│   ├── metadata.min.js         # Metadata snapshot, validation, field pruning
│   ├── utils.min.js            # Core record transforms (shaping, transforms, constants)
│   ├── config/
│   │   ├── index.js            # Re-exports all config loaders
│   │   ├── pipeline.js         # Load pipeline.json with env overlay
│   │   ├── constants.js        # Load constants.json with env overlay
│   │   ├── step-config.js      # Load object mapping configs (4-level merge, cached)
│   │   └── utils.js            # JSON5 reader, deepMerge helper
│   ├── mapping/
│   │   └── ref-solver.js       # Foreign key reference resolution engine
│   └── utils/
│       ├── logger.js           # Console logger (level-gated, timestamped)
│       ├── runlog.js           # Single per-run file logger
│       └── permset.js          # Permission Set creation, FLS grant, user assignment
├── services/
│   └── generators.js           # Custom data generators for complex object hierarchies
├── config/
│   ├── pipeline.json           # Pipeline step definitions
│   ├── constants.json          # Shared constant values
│   └── sales/
│       ├── data/seed.json      # Sample seed data (Account, Contact, Opportunity)
│       └── mappings/
│           ├── Account.json    # Account mapping config
│           ├── Contact.json    # Contact mapping config
│           └── Opportunity.json # Opportunity mapping config
├── meta-data/                  # (generated) Org describe cache: meta-data/<ORG_ID>/<Object>.json
└── logs/                       # (generated) Per-run log files: run-YYYYMMDD_HHMMSSZ.log
```

### Data Flow Diagram

```
.env + config/pipeline.json
        │
        ▼
┌─────────────────────┐
│   scripts/runLoad.js │  (orchestrator)
└──────────┬──────────┘
           │
           ├─► lib/auth.js ──────────────► Salesforce (login)
           │                                      │
           │                                      ▼
           ├─► lib/metadata.min.js ◄──── meta-data/<ORG_ID>/
           │   (snapshot + validate)
           │
           ├─► lib/validators/validatematchkeys.js
           │   (check/create external ID fields)
           │
           └─► for each step (topologically sorted):
                │
                ├─► lib/config/step-config.js   (load mapping config)
                ├─► config/sales/data/seed.json  (load seed data)
                ├─► lib/filters.js               (filter records)
                ├─► services/generators.js        (generate records if mode=generate)
                │
                └─► lib/loader.js ──────────────► idMap[externalKey → SalesforceId]
                    │
                    ├─ lib/utils.min.js           (resolveConstantsDeep, shapeRecord,
                    │                              applyTransforms, assertRequiredFields)
                    ├─ lib/mapping/ref-solver.js  (resolveReferences via idMaps)
                    ├─ lib/metadata.min.js         (pruneRecordFields, validateBatch)
                    └─ lib/sf.js                  (commit: REST / Composite / Bulk)
                                                         │
                                                         ▼
                                                  Salesforce Org
```

---

## 2. Core Modules

### `scripts/runLoad.js`
**Purpose**: Main entry point. Orchestrates the full pipeline run.

**Inputs**: Environment variables, `config/pipeline.json`, seed data files, mapping configs.

**Outputs**: Committed Salesforce records; `logs/run-<stamp>.log` with per-step summaries and final JSON report.

**Key functions**:

| Function | Description |
|---|---|
| `main()` | Async pipeline runner: auth → snapshot → validate → execute steps → log report |
| `topoSortSteps(steps)` | Kahn's algorithm topological sort by `dependsOn`; falls back to original order on cycle |
| `runGenerator(step, rawData, idMaps)` | Dispatches `mode: "generate"` steps to named functions in `services/generators.js` |
| `loadDataFile(absOrRel)` | JSON5-aware file loader with process-level memoization |
| `upsertIdMap(store, objectName, newMap)` | Merges a step's id map into the global store with configurable precedence |

---

### `lib/auth.js`
**Purpose**: Salesforce authentication.

**Inputs**: `SF_LOGIN_URL`, `SF_USERNAME`, `SF_PASSWORD` environment variables.

**Outputs**: Authenticated `jsforce.Connection` instance.

**Key function**: `getConnection()` — creates a `jsforce.Connection`, calls `conn.login()`, returns the connection.

---

### `lib/loader.js`
**Purpose**: Per-step data transformation and commit pipeline.

**Inputs**: jsforce connection, object name, raw records array, mapping config object, accumulated `idMaps`, constants.

**Outputs**: `Promise<idMap>` — object mapping external key values to Salesforce IDs for successfully committed records.

**Key function**: `insertAndMap(conn, objectName, records, cfg, idMaps, constants)`

**Processing order**:
1. Resolve `${constants.*}` placeholders in config (`resolveConstantsDeep`)
2. Load org metadata from cache (`loadObjectDescribeFromCache`)
3. For each record: resolve constants → apply pre-transforms → shape record → resolve references → apply post-transforms
4. Prune unknown and non-writable fields (`pruneRecordFields`)
5. Validate all fields exist and are writable (`validateBatch`)
6. Assert required fields per record (`assertRequiredFields`)
7. Enforce client-side uniqueness (`validate.uniqueBy`)
8. Chunk records into batches of `strategy.batchSize`
9. Commit each batch (`lib/sf.js commit()`)
10. Build and return `idMap` from processed records

---

### `lib/sf.js`
**Purpose**: Salesforce DML commit strategies.

**Inputs**: jsforce connection, object name, record batch array, strategy config object.

**Outputs**: Normalized result object with `created`, `updated`, `failures`, `processedRecords`.

**Exported function**: `commit(conn, objectName, batch, strategy)` — routes to one of three internal strategies based on `strategy.api`.

#### `commitREST(conn, objectName, batch, strategy)`
- Uses `conn.sobject(objectName).insert()` or `.upsert(batch, externalIdField)`
- After upsert, queries org with `$in` to verify committed records
- Returns `{ operation, results, created, updated, failures, processedRecords }`

#### `commitComposite(conn, objectName, batch, strategy)`
- Falls back to sequential per-record REST calls (true Composite not implemented)
- Returns raw results array

#### `commitBulk(conn, objectName, batch, strategy)`
- Uses `conn.bulk2.loadAndWaitForResults({ object, operation, input, pollTimeout, pollInterval })`
- jsforce CSV-encodes records internally
- Aligns results by external ID for upsert; by position for insert
- After commit, queries org with `$in` to verify (non-fatal if query fails)
- Default `pollTimeout`: 600,000 ms (10 min); default `pollInterval`: 2,000 ms

---

### `lib/filters.js`
**Purpose**: Declarative record filtering.

**Exported functions**:
- `matchPredicate(rec, spec, ctx)` — evaluates a single predicate object against a record
- `applyFilter(records, filterSpec, ctx)` — applies filter (single predicate, array of predicates as AND, or boolean shortcut) to a records array

**Supported predicates**:

| Predicate | Behavior |
|---|---|
| `exists` | Field is not null/undefined |
| `missing` | Field is null or undefined |
| `equals` | Strict or case-insensitive equality (`ci: true`) |
| `neq` | Inequality |
| `in` | Value in array |
| `nin` | Value not in array |
| `regex` | RegExp match (`pattern`, `flags`) |
| `gt`, `gte`, `lt`, `lte` | Numeric comparison |
| `contains` | Substring match |
| `startsWith` | Prefix match |
| `endsWith` | Suffix match |
| `length` | String length check (`op`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`) |
| `all` | AND of sub-predicates |
| `any` | OR of sub-predicates |
| `not` | Negation |
| `expr` | Inline JS expression (receives `rec`, `ctx`) |

**Note**: `expr` uses `new Function()` to evaluate expressions. Debug with `ctx.env.DEBUG_FILTERS = true`.

---

### `lib/mapping/ref-solver.js`
**Purpose**: Resolves declarative foreign key references to Salesforce IDs using accumulated `idMaps`.

**Exported functions**:
- `resolveRef(entry, record, idMaps, currentObject)` — resolves a single reference entry to a Salesforce ID
- `resolveReferences(rec, references, idMaps, currentObject)` — applies all reference entries to a record (mutates and returns it)
- `inferTargetObject(field, currentObject)` — infers target object from field name (e.g., `AccountId` → `Account`)
- `getByPath(obj, path)` — safe dot-notation getter with array index support

**Reference entry fields**:

| Field | Type | Description |
|---|---|---|
| `field` | string | Target field on the record to populate |
| `refKey` | string \| string[] | Seed record field(s) whose value is the lookup key in `idMaps` |
| `refKeyTemplate` / `template` / `keyTemplate` / `compositeKeyTemplate` | string | Template string with `${fieldName}` for computed keys |
| `refObject` | string | Target idMaps bucket; required for custom lookups |
| `onMissing` | `"error"` \| `"null"` \| `"skip"` | Behavior when key not found (default: `"error"`) |
| `required` | boolean | If true, missing key always throws |
| `from` | string | Legacy: `"idMaps.<Object>['${keyField}']"` |

**`DEBUG_REFS=true`**: Logs every reference entry to console debug output.

---

### `lib/runcontext.js`
**Purpose**: Process-level singleton holding the current org ID.

| Export | Description |
|---|---|
| `setOrgId(id)` | Store org ID after successful metadata snapshot |
| `getOrgId()` | Retrieve org ID; throws if not yet set |
| `hasOrgId()` | Check if org ID is set |
| `resetOrgId()` | Clear org ID (for testing) |

---

### `lib/config/step-config.js`
**Purpose**: Load and merge object mapping configs for a pipeline step.

**Exported function**: `loadStepConfig(step, options)`

**Merge precedence** (lowest → highest):
1. `config/base/<Object>.json` — optional base config
2. `config/env/<envName>/<Object>.json` — optional env overlay
3. `step.configFile` — required step-specific config
4. `step.configInline` — optional inline object override

**Merge strategy**: Deep merge for plain objects; arrays are **replaced** (not merged).

**Caching**: Memoized in a process-level `Map` keyed by a stable JSON hash of (objectName, resolved paths, envName, inline hash).

**Throws**: `StepConfigError` if `step.object` or `step.configFile` is missing, or if `step.configFile` does not exist on disk.

---

### `lib/config/pipeline.js`
**Purpose**: Load and optionally env-overlay the `pipeline.json`.

**Function**: `loadPipeline({ configDir, envName })` — loads `config/pipeline.json`, applies `config/env/<envName>/pipeline.json` if it exists, returns merged config.

---

### `lib/config/constants.js`
**Purpose**: Load and optionally env-overlay `constants.json`.

**Function**: `loadConstants({ configDir, envName })` — loads `config/constants.json` if it exists, applies `config/env/<envName>/constants.json` if it exists, returns merged constants object.

---

### `lib/config/utils.js`
**Purpose**: Shared low-level config utilities.

| Export | Description |
|---|---|
| `readJSON(filePath)` | Read a file with JSON5 parser (permissive: comments, trailing commas) |
| `deepMerge(target, ...sources)` | Recursively merge objects; arrays replaced |

---

### `lib/metadata.min.js` (minified)
**Purpose**: Org metadata snapshot, caching, field validation, and record pruning.

**Key exports**:

| Export | Description |
|---|---|
| `snapshotOrgMetadata(conn, opts)` | Fetch describe for all pipeline objects; cache under `meta-data/<orgId>/`; concurrency capped at `opts.concurrency` |
| `loadObjectDescribeFromCache(objectName)` | Read cached describe JSON for an object |
| `ensureObjectMetadataAvailable(objectName)` | Throw if object describe is not in cache |
| `toFieldMap(describe)` | Convert describe result to a `Map<fieldName, fieldDescribe>` |
| `validateBatch(objectName, records, fieldMap, { operation })` | Warn if records contain fields not in `fieldMap` or not writable |
| `pruneRecordFields(objectName, records, fieldMap, { operation, pruneUnknown, pruneNotWritable })` | Remove unknown and/or non-writable fields from each record |

**Cache location**: `meta-data/<ORG_ID>/<ObjectApiName>.json` (relative to project root).

---

### `lib/utils.min.js` (minified)
**Purpose**: Core per-record transform functions.

| Export | Description |
|---|---|
| `shapeRecord(record, config)` | Apply `shape.fieldMap` (rename), `shape.defaults` (fill missing), `shape.removeFields` (drop) |
| `applyTransforms(record, transforms)` | Execute transform operations: `assign`, `copy`, `rename`, `remove`, `coalesce`, `concat` |
| `resolveConstantsDeep(config, constants)` | Recursively replace `${constants.<path>}` in any string value within `config` |
| `assertRequiredFields(record, fields, label)` | Throw if any field in `fields` is null/undefined/empty on `record` |

---

### `lib/utils/logger.js`
**Purpose**: Leveled console logger with ISO timestamps.

**Log format**: `[<ISO timestamp>] [<object>] <message>`

**Levels**: `error` (0) < `warn` (1) < `info` (2) < `debug` (3). Controlled by `LOG_LEVEL` env var (default: `info`).

**Exports**: `log` object with methods: `info`, `warn`, `error`, `debug`, `stepStart`, `stepEnd`, `summarizeResults`.

Note: `stepStart` and `stepEnd` are stubs (timer calls are commented out).

---

### `lib/utils/runlog.js`
**Purpose**: Append-mode file logger writing a single log file per run.

**Function**: `createRunLogSingle(baseDir)` — creates `logs/run-YYYYMMDD_HHMMSSZ.log` (UTC timestamp). Returns logger object.

| Method | Description |
|---|---|
| `write(tag, msg)` | Append `[<timestamp>] [<tag>] <msg>\n` |
| `writeJson(tag, label, obj)` | Append `[tag] label >>>\n<JSON>\n[tag] <<< END JSON\n` |
| `close()` | Flush and close write stream |

**Properties**: `runId` (string), `path` (absolute file path).

---

### `lib/utils/permset.js`
**Purpose**: Manage Salesforce Permission Sets for auto-creating external ID field access.

**Key functions**:
- `ensurePermissionSetExists(conn, psName)` — find or create a named Permission Set
- `upsertFieldPermissions(conn, psId, objectName, fieldNames)` — merge field-level permissions (Read + Edit)
- `assignPermissionSetToUser(conn, psId, userId)` — assign the Permission Set to user (with retry)
- `grantFieldAccessWithPermSet(conn, objectName, fieldNames, psName, userId)` — end-to-end: ensure PS, grant FLS, assign

---

### `lib/validators/validatematchkeys.js`
**Purpose**: Pre-run validation that all mapping `identify.matchKey` fields exist in the org.

**Function**: `validateMatchKeysFromSnapshots({ steps, metaDir, orgId, loadStepConfig, envName, cwd, logFn, consoleLog, conn })`

**Process**:
1. For each step, load mapping config and read `identify.matchKey`
2. Load cached describe for the object from `meta-data/<orgId>/<Object>.json`
3. Check if the field exists in the describe's field list
4. If missing and `AUTO_CREATE_MATCH_KEYS=true`: create field via metadata API, grant FLS via `grantFieldAccessWithPermSet`, re-snapshot the object
5. If missing and auto-create disabled: log a warning

---

### `services/generators.js`
**Purpose**: Custom data generators for complex synthetic data patterns.

**Exports**: `generators` object mapping names to functions.

| Generator | Description |
|---|---|
| `generateExpertLocationJunctions(data, idMaps)` | Creates junction records between `BKAI__Expert__c` and `BKAI__Location__c` using resolved Salesforce IDs from idMaps |
| `generateShiftPatternsPerLocation(data, idMaps)` | Clones each shift pattern template for every location, resolving location IDs from idMaps |
| `generateChildLocationsWithHierarchy(data, idMaps)` | Filters location records that have a parent, replaces seed parent IDs with resolved Salesforce IDs |

**Contract**: Every generator receives `(data: Object, idMaps: Object)` and must return `Array<Object>`.

---

## 3. Pipeline Execution Flow

```
1. Load .env (dotenv)

2. Read ENV_NAME = LOADER_ENV || NODE_ENV || "dev"
   Read DRY_RUN = process.env.DRY_RUN === "true"

3. Authenticate (lib/auth.js)
   conn = await getConnection()           ← skipped in DRY_RUN

4. Load pipeline config (lib/config/pipeline.js)
   pipelineCfg = loadPipeline({ envName })

5. Load constants (lib/config/constants.js)
   constants = loadConstants({ envName })

6. Compute unique object list from pipeline steps

7. Snapshot org metadata (lib/metadata.min.js)
   snapshot = await snapshotOrgMetadata(conn, {
     objectNames, metaDir, forceRefresh, concurrency: 2
   })
   → Writes meta-data/<orgId>/<Object>.json for each object
   → Fatal if any object is unavailable
   setOrgId(snapshot.orgId)

8. Topological sort steps
   stepsOrdered = topoSortSteps(pipelineCfg.steps)

9. Validate match keys (lib/validators/validatematchkeys.js)
   validateMatchKeysFromSnapshots({ steps, metaDir, orgId, ... })
   → Per step: check matchKey exists in describe; auto-create if enabled

10. Initialize: idMaps = {}, runReport = {}

11. For each step in stepsOrdered:

    a. Load mapping config
       cfg = loadStepConfig(step, { envName, cwd, cache: true })

    b. Load seed data
       rawData = loadDataFile(step.dataFile)
       baseData = rawData[step.dataKey]          ← or rawData if no dataKey

    c. Apply filter
       working = applyFilter(baseData, step.filter)

    d. Resolve records
       if step.mode === "generate":
         finalData = generators[step.generator](rawData, idMaps)
       else:
         finalData = working

    e. Transform + commit (lib/loader.js)
       if DRY_RUN:
         log sample, skip commit
       else:
         idMap = await insertAndMap(conn, obj, finalData, cfg, idMaps, constants)
         ├─ resolveConstantsDeep(cfg, constants)
         ├─ loadObjectDescribeFromCache(obj)
         ├─ per record: resolveConstantsDeep → applyTransforms(pre) → shapeRecord → resolveReferences → applyTransforms(post)
         ├─ pruneRecordFields(...)
         ├─ validateBatch(...)
         ├─ assertRequiredFields(...)
         ├─ uniqueness check
         ├─ chunk into batches
         └─ commit(conn, obj, batch, strategy)   ← REST / Composite / Bulk

    f. Merge idMap into global idMaps
       upsertIdMap(idMaps, obj, idMap, { preferExisting: true })

    g. Log step summary to console and runLog

12. Write final JSON run report to log file
    runLog.writeJson("System", "RUN REPORT", runReport)

13. Close log file
```

---

## 4. Configuration System

### pipeline.json

Located at `config/pipeline.json`. Optional env overlay at `config/env/<ENV_NAME>/pipeline.json`.

```jsonc
{
  "dryRun": false,          // optional pipeline-level dry run flag
  "steps": [
    {
      "object": "Account",              // Salesforce API object name (required)
      "dataFile": "./config/sales/data/seed.json",  // path to seed data (required)
      "dataKey": "Account",             // key within data file (required if root is object)
      "mode": "direct",                 // "direct" or "generate" (default: "direct")
      "configFile": "./config/sales/mappings/Account.json",  // mapping file (required)
      "dependsOn": [],                  // object names this step depends on
      "filter": null,                   // optional filter predicate(s)
      "generator": null                 // generator name if mode="generate"
    }
  ]
}
```

### Object Mapping Config

Each step's `configFile` is a JSON file with the following schema:

```jsonc
{
  "identify": {
    "matchKey": "External_Id__c"   // field used as idMap key and uniqueness anchor
  },
  "shape": {
    "fieldMap": {                  // rename source fields: { "srcField": "destField" }
      "OldName": "NewName"
    },
    "defaults": {                  // set defaults only if field absent/null
      "Type": "Customer",
      "StageName": "${constants.oppty.defaultStageName}"
    },
    "removeFields": ["FieldToDrop"] // fields to remove from record before commit
  },
  "transform": {
    "pre": [],   // transforms applied before reference resolution
    "post": [    // transforms applied after reference resolution
      { "op": "remove", "field": "AccountExternalId" }
    ]
  },
  "references": [
    {
      "field": "AccountId",        // target field to populate
      "refObject": "Account",      // idMaps bucket to look up
      "refKey": "${AccountExternalId}", // template resolved against current record
      "required": true,            // throw if not resolved
      "onMissing": "error"         // "error" | "null" | "skip"
    }
  ],
  "validate": {
    "requiredFields": ["Name", "External_Id__c"],  // must be non-empty after transforms
    "uniqueBy": ["External_Id__c"]  // client-side uniqueness guard
  },
  "strategy": {
    "operation": "upsert",         // "insert" or "upsert"
    "externalIdField": "External_Id__c",  // required for upsert
    "api": "rest",                 // "rest", "composite", or "bulk"
    "batchSize": 200,              // records per API call
    "pollTimeoutMs": 600000,       // bulk only (default 10 min)
    "pollIntervalMs": 2000         // bulk only (default 2s)
  }
}
```

### Transform Operations (`shape.transform.pre` / `.post`)

Each transform is an object with an `op` field:

| `op` | Fields | Description |
|---|---|---|
| `assign` | `field`, `value` | Set field to a constant value |
| `copy` | `from`, `to` | Copy value from one field to another |
| `rename` | `from`, `to` | Move value and delete source field |
| `remove` | `field` | Delete a field |
| `coalesce` | `fields`, `to` | Set `to` to first non-empty value from `fields` |
| `concat` | `fields`, `to`, `sep` | Concatenate field values with separator |

### Constants

Located at `config/constants.json`. Values are accessible as `${constants.<dotPath>}` in mapping configs and seed data values.

```json
{
  "oppty": {
    "defaultStageName": "Prospecting",
    "defaultCloseDate": "2025-09-30"
  }
}
```

### Environment Overlay System

| Layer | Path | Purpose |
|---|---|---|
| Base pipeline | `config/pipeline.json` | Default pipeline |
| Env pipeline | `config/env/<ENV>/pipeline.json` | Override for specific env |
| Base constants | `config/constants.json` | Default constants |
| Env constants | `config/env/<ENV>/constants.json` | Override constants per env |
| Base mapping | `config/base/<Object>.json` | Shared object defaults |
| Env mapping | `config/env/<ENV>/<Object>.json` | Env-specific mapping override |
| Step mapping | `step.configFile` | Primary mapping config |
| Inline mapping | `step.configInline` | Highest-priority inline override |

`ENV_NAME` is resolved from: `LOADER_ENV` → `NODE_ENV` → `"dev"`.

---

## 5. Data Loading Strategies

| API | `strategy.api` | Operations | Notes |
|---|---|---|---|
| REST | `"rest"` | `insert`, `upsert` | Per-batch jsforce call; post-commit verification query |
| Composite | `"composite"` | `insert`, `upsert` | Falls back to sequential per-record REST; true composite not implemented |
| Bulk 2.0 | `"bulk"` | `insert`, `upsert` | `conn.bulk2.loadAndWaitForResults`; polls until complete; non-fatal verification query |

---

## 6. Transformation & Generator System

### Transformation Pipeline (per record, in order)

```
raw seed record
    │
    ├─ resolveConstantsDeep(record, constants)
    │      Replace ${constants.*} in string values
    │
    ├─ applyTransforms(record, cfg.transform.pre)
    │      assign / copy / rename / remove / coalesce / concat
    │
    ├─ shapeRecord(record, cfg)
    │      1. Apply cfg.shape.fieldMap (rename fields)
    │      2. Apply cfg.shape.defaults (fill missing fields)
    │      3. Apply cfg.shape.removeFields (drop fields)
    │
    ├─ resolveReferences(record, cfg.references, idMaps, objectName)
    │      For each reference entry:
    │        - Render refKey template against record
    │        - Look up resolved Salesforce ID in idMaps[refObject]
    │        - Set record[field] = resolvedId
    │
    └─ applyTransforms(record, cfg.transform.post)
           Typically used to remove helper fields (e.g., "AccountExternalId")
```

### Built-in Generators

Registered in `services/generators.js` as named properties of the `generators` export object.

| Name | Domain | Description |
|---|---|---|
| `generateExpertLocationJunctions` | BKAI | Creates `BKAI__Expert_Location__c` junction records for each expert using their `BKAI__Location__c` seed value resolved via idMaps |
| `generateShiftPatternsPerLocation` | BKAI | For each location × shift template combination, creates a shift pattern record with resolved location ID |
| `generateChildLocationsWithHierarchy` | BKAI | Filters locations with a parent, replaces seed parent IDs with Salesforce IDs from idMaps |

All generators are invoked as: `generators[name](rawData, idMaps)` where `rawData` is the full parsed content of `step.dataFile`.

---

## 7. Logging & Error Handling

### Console Logger (`lib/utils/logger.js`)

- Format: `[<ISO8601>] [<object/module>] <message>`
- Level controlled by `LOG_LEVEL` env var: `error` | `warn` | `info` | `debug` (default: `info`)
- Each log call is no-op if current level is below the called level

### Run Log File (`lib/utils/runlog.js`)

- One file per process run: `logs/run-YYYYMMDD_HHMMSSZ.log` (UTC)
- Created at the start of `main()` via `createRunLogSingle("logs")`
- `write(tag, msg)`: structured plain-text line with timestamp and tag
- `writeJson(tag, label, obj)`: pretty-printed JSON block with delimiters
- `close()`: flushes and closes the write stream

### Run Report (final JSON block in log file)

```json
{
  "env": "dev",
  "dryRun": false,
  "startedAt": "2025-01-01T00:00:00.000Z",
  "finishedAt": "2025-01-01T00:01:30.000Z",
  "totalElapsedMs": 90000,
  "steps": [
    {
      "object": "Account",
      "dataFile": "./config/sales/data/seed.json",
      "dataKey": "Account",
      "mode": "direct",
      "generator": null,
      "configFile": "./config/sales/mappings/Account.json",
      "attempted": 20,
      "ok": 20,
      "errors": 0,
      "elapsedMs": 3200
    }
  ],
  "totals": {
    "attempted": 60,
    "insertedOrUpserted": 60,
    "errors": 0
  }
}
```

### Error Handling

| Scenario | Behavior |
|---|---|
| Salesforce auth failure | Unhandled jsforce error; run aborts; logged to console |
| Object not in org (snapshot) | Fatal: logged to run log; process exits |
| Missing `step.object` / `step.dataFile` / `step.configFile` | Fatal throw before step executes |
| `step.configFile` not found on disk | `StepConfigError` thrown; run aborts |
| Cyclic `dependsOn` | Warning logged; original step order used |
| Missing required field (post-transform) | Fatal throw; run aborts |
| Uniqueness violation (client-side) | Fatal throw; run aborts |
| DML failure (per-record) | Logged per failure; idMap entry not created; run continues |
| Generator not registered | Fatal throw: "Unknown generator '...'" |
| Bulk API verification query failure | Non-fatal; warning logged; execution continues |
| Top-level `main()` rejection | `catch` writes error to run log and `console.error`; `process.exit(1)` |

---

## 8. Dependencies

| Package | Version | Role |
|---|---|---|
| `jsforce` | `^3.10.8` | Salesforce API client: REST, Bulk 2.0, Metadata API, Composite |
| `dotenv` | `^16.3.1` | Load environment variables from `.env` file |
| `json5` | `^2.2.3` | Permissive JSON parser (comments, trailing commas) for config and data files |
| `chalk` | `^5.3.0` | Terminal color support (imported in project; usage in logging TBD) |
| `jszip` | `^3.10.1` | ZIP file generation used by metadata API operations (Permission Set, field creation) |

All packages are runtime dependencies (no `devDependencies` defined).
