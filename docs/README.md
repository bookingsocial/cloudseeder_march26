# CloudSeeder

CloudSeeder is a Node.js CLI tool that loads declaratively-configured seed data into Salesforce orgs. It reads JSON pipeline definitions, applies field mappings and data transformations, resolves parent-child foreign-key references, and writes records via the REST, Composite, or Bulk API 2.0.

**Primary use cases:** demo org setup, sandbox refresh, CI test-data reset, initial data population.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Project Structure](#project-structure)
4. [How It Works](#how-it-works)
5. [Pipeline Config Reference](#pipeline-config-reference)
6. [Mapping Config Reference](#mapping-config-reference)
7. [Constants](#constants)
8. [Filters](#filters)
9. [Transforms](#transforms)
10. [Environment Variables](#environment-variables)
11. [Dry Run Mode](#dry-run-mode)
12. [Metadata Validation & Caching](#metadata-validation--caching)
13. [Logging](#logging)
14. [Use Cases](#use-cases)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Uses native ES modules (`"type": "module"`) |
| Salesforce credentials | Username, password (+ security token), login URL |
| External ID field | One per object being seeded; auto-created if `AUTO_CREATE_MATCH_KEYS=true` |

Install dependencies:

```bash
npm install
```

---

## Quick Start

1. **Set environment variables** (create a `.env` file or export in shell):

```env
SF_LOGIN_URL=https://login.salesforce.com
SF_USERNAME=you@yourorg.com
SF_PASSWORD=yourpassword+token
ENV_NAME=dev            # optional: selects config/env/dev/ overlay
DRY_RUN=false           # set true to preview without writing
LOG_LEVEL=info
```

2. **Provide your config files** under `config/`:
   - `config/pipeline.json` — step definitions and execution order
   - `config/constants.json` — shared constant values (optional)
   - `config/<org>/mappings/<Object>.json` — one mapping file per object

3. **Run:**

```bash
node scripts/runLoad.js
```

---

## Project Structure

```
cloudseeder/
├── scripts/
│   └── runLoad.js                  # Entry point
├── lib/
│   ├── config/                     # Pipeline, constants, step-config loading
│   ├── pipeline/                   # Step execution, topo-sort, generators
│   ├── filters.js                  # Declarative filter predicates
│   ├── commit/                     # commitREST, commitComposite, commitBulk
│   └── metadata.js                 # Object describe, field pruning, auto-create
├── config/
│   ├── pipeline.json               # Pipeline step definitions
│   ├── constants.json              # Shared ${constants.*} values
│   ├── base/                       # Base mapping overrides (all envs)
│   ├── env/<ENV_NAME>/             # Per-environment overlays
│   └── <scenario>/
│       ├── data/
│       │   └── seed.json           # Source records
│       └── mappings/
│           ├── Account.json
│           ├── Contact.json
│           └── Opportunity.json
├── meta-data/                      # Cached Salesforce object describes (per org)
├── logs/                           # Per-run timestamped log files
└── docs/
    ├── README.md                   # This file
    └── usecases/
        ├── sales.md
        ├── producthierarchy.md
        └── fieldservice.md
```

---

## How It Works

```
pipeline.json
     │
     ▼
Topological sort (by dependsOn)
     │
     ▼  for each step:
┌─────────────────────────────────────────┐
│  1. Load seed records (dataFile/dataKey)│
│  2. Apply filter                        │
│  3. Shape: fieldMap, defaults, remove   │
│  4. Pre-transforms                      │
│  5. Resolve references → idMaps         │
│  6. Post-transforms                     │
│  7. Validate required fields + uniqueBy │
│  8. Prune fields not in org describe    │
│  9. Batch & commit to Salesforce        │
│ 10. Build idMap: externalKey → SF Id    │
└─────────────────────────────────────────┘
     │
     ▼
idMaps passed to all subsequent steps
```

**idMaps** accumulate across every completed step. If Account is seeded first, all later steps can resolve `AccountId` by looking up `idMaps.Account["acct-001"]`.

---

## Pipeline Config Reference

`config/pipeline.json`

```json
{
  "dryRun": false,
  "steps": [
    {
      "object":       "Account",
      "dataFile":     "./config/sales/data/seed.json",
      "dataKey":      "Account",
      "mode":         "direct",
      "configFile":   "./config/sales/mappings/Account.json",
      "dependsOn":    [],
      "filter":       { "missing": "ParentExternalId" },
      "configInline": { "strategy": { "batchSize": 50 } }
    }
  ]
}
```

### Step fields

| Field | Required | Description |
|---|---|---|
| `object` | Yes | Salesforce API object name (`Account`, `Contact`, etc.) |
| `dataFile` | Yes | Path to seed data file (relative to repo root) |
| `dataKey` | No | Key inside the data file. Omit if the root is an array. |
| `mode` | No | `"direct"` (default) or `"generate"` |
| `configFile` | Yes | Path to the object mapping config |
| `dependsOn` | No | Objects that must complete before this step runs |
| `filter` | No | Declarative predicate to subset records (see [Filters](#filters)) |
| `generator` | No | Generator function name (only when `mode: "generate"`) |
| `configInline` | No | Inline mapping overrides — highest precedence in the merge chain |

### Config merge order (lowest → highest precedence)

1. `config/base/<Object>.json`
2. `config/env/<ENV_NAME>/<Object>.json`
3. `step.configFile`
4. `step.configInline`

---

## Mapping Config Reference

Each object has one mapping config (e.g., `config/sales/mappings/Account.json`):

```json
{
  "identify":   { "matchKey": "External_Id__c" },
  "shape":      { "fieldMap": {}, "defaults": {}, "removeFields": [] },
  "transform":  { "pre": [], "post": [] },
  "references": [],
  "validate":   { "requiredFields": [], "uniqueBy": [] },
  "strategy":   { "operation": "upsert", "externalIdField": "External_Id__c", "api": "bulk", "batchSize": 200 }
}
```

### `identify`

| Field | Description |
|---|---|
| `matchKey` | Field used as the unique key for `idMap` indexing and upsert external ID. Must exist in the org. |

### `shape`

| Field | Description |
|---|---|
| `fieldMap` | Rename fields: `{ "SeedFieldName": "SFFieldName" }` |
| `defaults` | Set a field value only when the record field is missing or undefined. Supports `${constants.*}` tokens. |
| `removeFields` | Drop these fields before committing (e.g., universal helper columns like `_debug`). |

### `transform`

Transforms are applied as an ordered array of operations.

| Stage | When |
|---|---|
| `pre` | Before reference resolution |
| `post` | After reference resolution — use for removing helper columns like `AccountExternalId` |

**Transform operations:**

| `op` | Required fields | Description |
|---|---|---|
| `assign` | `field`, `value` | Set `field` to a literal `value` |
| `copy` | `from`, `to` | Copy value of `from` field to `to` field |
| `rename` | `from`, `to` | Move value and delete source |
| `remove` | `field` | Delete the field from the record |
| `coalesce` | `out`, `from[]`, `default` | Write first non-empty value from `from` array to `out`; use `default` if all are empty |
| `concat` | `out`, `parts[]`, `sep` | Join values of `parts` fields with `sep` separator into `out` |

### `references`

Resolves Salesforce lookup IDs from prior steps' idMaps.

```json
{
  "field":     "AccountId",
  "refObject": "Account",
  "refKey":    "${AccountExternalId}",
  "required":  true,
  "onMissing": "error"
}
```

| Field | Description |
|---|---|
| `field` | Target Salesforce lookup field |
| `refObject` | Object name in idMaps. Inferred from `field` if omitted (e.g., `AccountId` → `Account`). |
| `refKey` | Key to look up. Supports `${seedField}` template syntax. Also accepts an array (first non-empty wins). |
| `required` | Throw if not resolved (default: `true`) |
| `onMissing` | `"error"` (default) \| `"null"` (set to null) \| `"skip"` (omit field) |

### `validate`

| Field | Description |
|---|---|
| `requiredFields` | Fields that must be present and non-empty after all transforms; missing causes a fatal error |
| `uniqueBy` | Client-side duplicate check across these fields before committing |

### `strategy`

| Field | Description |
|---|---|
| `operation` | `"insert"` or `"upsert"` |
| `externalIdField` | Salesforce External ID API name (required for upsert) |
| `api` | `"rest"` \| `"composite"` \| `"bulk"` |
| `batchSize` | Records per API batch (default: 200) |
| `pollTimeoutMs` | Bulk only: polling timeout in ms (default: 600000) |
| `pollIntervalMs` | Bulk only: poll interval in ms (default: 2000) |

---

## Constants

`config/constants.json` holds reusable values. Reference them anywhere in mapping configs or seed data with `${constants.<path>}`.

```json
{
  "oppty": {
    "defaultStageName": "Prospecting",
    "defaultCloseDate": "2025-09-30"
  }
}
```

Usage in a mapping default:

```json
"defaults": {
  "StageName": "${constants.oppty.defaultStageName}"
}
```

Per-environment overrides are loaded from `config/env/<ENV_NAME>/constants.json` and deep-merged over the base.

---

## Filters

Filters subset seed records before processing. Applied at the step level via `step.filter`.

### Simple predicates

| Predicate | Example | Matches when |
|---|---|---|
| `exists` | `{ "exists": "ParentId" }` | Field is present and non-null |
| `missing` | `{ "missing": "ParentId" }` | Field is absent or null |
| `equals` | `{ "equals": { "field": "Level", "value": 2 } }` | Field equals value |
| `neq` | `{ "neq": { "field": "Status", "value": "Closed" } }` | Field does not equal value |
| `in` | `{ "in": { "field": "Type", "values": ["A","B"] } }` | Field is in the list |
| `nin` | `{ "nin": { "field": "Type", "values": ["X"] } }` | Field is not in the list |
| `regex` | `{ "regex": { "field": "Code", "pattern": "^PROD-" } }` | Field matches regex |
| `gt/gte/lt/lte` | `{ "gt": { "field": "Amount", "value": 1000 } }` | Numeric comparison |
| `contains` | `{ "contains": { "field": "Name", "value": "Corp" } }` | String contains substring |
| `startsWith` | `{ "startsWith": { "field": "Code", "value": "PROD" } }` | String starts with |
| `endsWith` | `{ "endsWith": { "field": "Code", "value": "-MRI" } }` | String ends with |

### Compound predicates

```json
{ "all": [ { "exists": "AccountExternalId" }, { "missing": "IsDeleted" } ] }
{ "any": [ { "equals": { "field": "Type", "value": "A" } }, { "equals": { "field": "Type", "value": "B" } } ] }
{ "not": { "equals": { "field": "Status", "value": "Inactive" } } }
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SF_LOGIN_URL` | Yes | — | `https://login.salesforce.com` or My Domain URL |
| `SF_USERNAME` | Yes | — | Salesforce username |
| `SF_PASSWORD` | Yes | — | Password + security token concatenated |
| `ENV_NAME` | No | `""` | Selects `config/env/<ENV_NAME>/` overlays |
| `DRY_RUN` | No | `false` | Process and transform records but skip all API writes |
| `REFRESH_METADATA` | No | `false` | Re-fetch and overwrite cached object describe snapshots |
| `AUTO_CREATE_MATCH_KEYS` | No | `false` | Auto-create External ID field if it doesn't exist in the org |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `debug` |
| `LOG_PRUNE` | No | `false` | Log pruned field names for the first 2 records of each step |
| `DEBUG_REFS` | No | `false` | Emit detailed reference resolution traces |

---

## Dry Run Mode

Enable with `DRY_RUN=true` (env var) or `"dryRun": true` in `pipeline.json`.

In dry run mode, CloudSeeder:
- Loads seed data
- Applies all transforms, shaping, filters
- Resolves references and validates payloads
- **Does not call any Salesforce write APIs**
- Prints shaped payloads and reference resolution results to console

Use this to validate a new config before committing records to an org.

---

## Metadata Validation & Caching

On first run, CloudSeeder calls `describe()` on every object in the pipeline and caches the result under `meta-data/<ORG_ID>/`. Subsequent runs use the cache.

**What it does with the metadata:**
- Prunes fields from records that don't exist in the org or aren't writable
- Validates that `identify.matchKey` is a valid external-ID field
- Auto-creates the match key field when `AUTO_CREATE_MATCH_KEYS=true`

**Refresh the cache:**

```bash
REFRESH_METADATA=true node scripts/runLoad.js
```

---

## Logging

Each run writes a log file to `logs/run-YYYYMMDD_HHMMSSZ.log` containing:
- Run start/stop timestamps
- Per-step summaries: records attempted, created, updated, failed, elapsed ms
- Final JSON run report with aggregate totals

Console output uses ISO timestamps and an object/module tag on every line. Verbosity is controlled by `LOG_LEVEL`.

**Final run report shape:**

```json
{
  "env": "dev",
  "dryRun": false,
  "startedAt": "2025-10-01T10:00:00Z",
  "finishedAt": "2025-10-01T10:00:45Z",
  "totalElapsedMs": 45000,
  "steps": [
    { "object": "Account", "attempted": 20, "ok": 20, "errors": 0, "elapsedMs": 3200 },
    { "object": "Contact", "attempted": 20, "ok": 20, "errors": 0, "elapsedMs": 2800 }
  ],
  "totals": { "attempted": 60, "ok": 60, "errors": 0 }
}
```

---

## Use Cases

Detailed, end-to-end examples in `docs/usecases/`:

| Use Case | File | Objects |
|---|---|---|
| Sales pipeline | [usecases/sales.md](usecases/sales.md) | Account, Contact, Opportunity |
| Product hierarchy | [usecases/producthierarchy.md](usecases/producthierarchy.md) | Product2 (3-level), Pricebook2, PricebookEntry |
| Field service locations | [usecases/fieldservice.md](usecases/fieldservice.md) | Location, Expert, junction & shift patterns (generated) |

Each use case document includes seed data, pipeline config, mapping files, execution flow, and operational tips.
