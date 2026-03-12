# CloudSeeder — Config-Driven Salesforce Data Loader

CloudSeeder is a Node.js CLI tool that loads declaratively-configured seed data into Salesforce orgs. It reads JSON pipeline definitions, applies field mappings and transforms, resolves parent-child foreign key references, and writes records via the Salesforce REST, Composite, or Bulk API 2.0.

---

## Prerequisites

- **Node.js**: v18 or later (ESM native modules required)
- **npm**: v8 or later
- **Salesforce credentials**: username + password + security token with API access
- **Salesforce org**: API-enabled org with target objects deployed
- **External ID fields**: Custom external ID fields must exist on target objects (or set `AUTO_CREATE_MATCH_KEYS=true` to create them automatically)

---

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd cloudseeder

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env   # or create .env manually (see Configuration below)
```

---

## Configuration

### 1. Environment Variables (`.env`)

Create a `.env` file in the project root:

```env
# Salesforce login URL
SF_LOGIN_URL=https://login.salesforce.com

# Salesforce credentials (password + security token concatenated, no space)
SF_USERNAME=you@example.com
SF_PASSWORD=yourPasswordyourSecurityToken

# Environment name — selects config/env/<LOADER_ENV>/ overlay files (default: dev)
LOADER_ENV=dev

# Set to true to force re-fetch of Salesforce object metadata
REFRESH_METADATA=false

# Set to true to auto-create missing external ID fields via Metadata API
AUTO_CREATE_MATCH_KEYS=false

# Console log level: error | warn | info | debug (default: info)
LOG_LEVEL=info

# Set to true to skip all Salesforce writes (transforms and logging still run)
DRY_RUN=false
```

### 2. Pipeline (`config/pipeline.json`)

Defines the steps to execute. Steps are topologically sorted by `dependsOn` before execution.

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
    }
  ]
}
```

**Step fields**:

| Field | Required | Description |
|---|---|---|
| `object` | Yes | Salesforce API object name (e.g., `Account`, `My_Object__c`) |
| `dataFile` | Yes | Path to seed data JSON/JSON5 file (repo-root relative) |
| `dataKey` | No | Key within the data file (omit if file root is an array) |
| `mode` | No | `"direct"` (default) or `"generate"` |
| `configFile` | Yes | Path to object mapping JSON file |
| `dependsOn` | No | Array of object names that must complete first |
| `filter` | No | Declarative filter predicate(s) to subset records |
| `generator` | No | Generator name (only used when `mode: "generate"`) |
| `configInline` | No | Inline mapping config overrides (highest precedence) |

### 3. Object Mapping Configs

Each step's `configFile` is a JSON file describing how to transform seed records:

```json
{
  "identify": {
    "matchKey": "External_Id__c"
  },
  "shape": {
    "fieldMap": { "OldFieldName": "NewFieldName" },
    "defaults": { "Type": "Customer" },
    "removeFields": ["HelperField"]
  },
  "transform": {
    "pre": [],
    "post": [
      { "op": "remove", "field": "AccountExternalId" }
    ]
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

**`strategy.api` options**: `"rest"`, `"composite"`, `"bulk"`

**`strategy.operation` options**: `"insert"`, `"upsert"`

**Transform `op` values**: `assign`, `copy`, `rename`, `remove`, `coalesce`, `concat`

**Reference `onMissing` options**: `"error"` (default), `"null"`, `"skip"`

### 4. Constants (`config/constants.json`)

Shared values accessible as `${constants.<path>}` in mapping defaults, transforms, and seed data:

```json
{
  "oppty": {
    "defaultStageName": "Prospecting",
    "defaultCloseDate": "2025-09-30"
  }
}
```

### 5. Environment Overlays (optional)

Place overlay files to override configs per environment:

```
config/
├── pipeline.json               # base pipeline
├── constants.json              # base constants
├── base/
│   └── Account.json           # base mapping applied to all envs
└── env/
    └── prod/
        ├── pipeline.json      # overrides base pipeline for "prod"
        ├── constants.json     # overrides base constants for "prod"
        └── Account.json       # overrides Account mapping for "prod"
```

Set `LOADER_ENV=prod` to activate the `prod` overlay.

---

## Usage

### Run the pipeline

```bash
npm start
```

This is equivalent to:

```bash
node scripts/runLoad.js
```

### Dry run (no Salesforce writes)

```bash
DRY_RUN=true npm start
```

Or set `"dryRun": true` in `config/pipeline.json`.

### Force metadata refresh

```bash
REFRESH_METADATA=true npm start
```

### Auto-create missing external ID fields

```bash
AUTO_CREATE_MATCH_KEYS=true npm start
```

### Verbose debug logging

```bash
LOG_LEVEL=debug npm start
```

### Log field pruning details

```bash
LOG_PRUNE=true npm start
```

### Debug reference resolution

```bash
DEBUG_REFS=true npm start
```

### Target a specific environment

```bash
LOADER_ENV=prod npm start
```

---

## File Structure

```
cloudseeder/
├── .env                          # Environment variables (not committed)
├── package.json                  # npm config; "type": "module" (ESM)
├── scripts/
│   └── runLoad.js                # CLI entry point and pipeline orchestrator
├── lib/
│   ├── auth.js                   # Salesforce login via jsforce
│   ├── loader.js                 # Per-step transform + commit pipeline
│   ├── sf.js                     # REST / Composite / Bulk commit strategies
│   ├── filters.js                # Declarative record filter engine
│   ├── runcontext.js             # Runtime singleton: org ID
│   ├── metadata.min.js           # Metadata snapshot, pruning, validation
│   ├── utils.min.js              # shapeRecord, applyTransforms, resolveConstantsDeep
│   ├── config/
│   │   ├── index.js              # Re-exports all config loaders
│   │   ├── pipeline.js           # Load pipeline.json (+ env overlay)
│   │   ├── constants.js          # Load constants.json (+ env overlay)
│   │   ├── step-config.js        # Load + merge object mapping configs (cached)
│   │   └── utils.js              # JSON5 reader, deepMerge
│   ├── mapping/
│   │   └── ref-solver.js         # Foreign key reference resolution
│   └── utils/
│       ├── logger.js             # Leveled console logger
│       ├── runlog.js             # Per-run file logger
│       └── permset.js            # Permission Set + FLS management
├── services/
│   └── generators.js             # Custom data generators
├── config/
│   ├── pipeline.json             # Pipeline definition (edit this)
│   ├── constants.json            # Shared constants
│   └── sales/
│       ├── data/
│       │   └── seed.json         # Sample seed data (Account, Contact, Opportunity)
│       └── mappings/
│           ├── Account.json      # Account mapping
│           ├── Contact.json      # Contact mapping
│           └── Opportunity.json  # Opportunity mapping
├── docs/
│   ├── README.md                 # User-facing guide
│   └── usecases/
│       ├── sales.md              # Sales Cloud example walkthrough
│       └── producthierarchy.md  # Product hierarchy example walkthrough
├── requirements/
│   ├── requirements.md           # Functional and non-functional requirements
│   └── implementation.md        # Architecture and module reference
├── meta-data/                    # (generated) Object describe cache
│   └── <ORG_ID>/
│       └── <Object>.json
└── logs/                         # (generated) Per-run log files
    └── run-YYYYMMDD_HHMMSSZ.log
```

---

## Logging

Every run produces:

1. **Console output** — timestamped lines with object/module tags, controlled by `LOG_LEVEL`
2. **Log file** — `logs/run-YYYYMMDD_HHMMSSZ.log` (UTC timestamp, append mode)

Log file format:
```
[2025-01-01T12:00:00.000Z] [System] Start — ENV=dev DRY_RUN=false
[2025-01-01T12:00:01.200Z] [SNAPSHOT] Complete ✅ orgId=00D...
[2025-01-01T12:00:02.100Z] [STEP:Account] START 🚀 #1 [Account]
[2025-01-01T12:00:05.400Z] [STEP:Account] SUMMARY ✅ ok=20 errors=0 elapsed=3,300 ms
...
[2025-01-01T12:01:30.000Z] [System] RUN REPORT >>>
{
  "env": "dev",
  "dryRun": false,
  "startedAt": "...",
  "finishedAt": "...",
  "totalElapsedMs": 90000,
  "steps": [...],
  "totals": { "attempted": 60, "insertedOrUpserted": 60, "errors": 0 }
}
[2025-01-01T12:01:30.000Z] [System] <<< END JSON
```

---

## Examples

### End-to-End: Sales Cloud Pipeline

This example loads 20 Accounts, 20 Contacts (linked to Accounts), and 20 Opportunities (linked to Accounts) from the bundled seed data.

**1. Configure `.env`**

```env
SF_LOGIN_URL=https://login.salesforce.com
SF_USERNAME=demo@example.com
SF_PASSWORD=MyPassword123MySecurityToken
AUTO_CREATE_MATCH_KEYS=true
REFRESH_METADATA=true
```

**2. Verify `config/pipeline.json`** (already set up for Sales Cloud)

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

**3. Preview with dry run**

```bash
DRY_RUN=true npm start
```

**4. Load data**

```bash
npm start
```

**5. Verify output**

```
[System] Authenticated to Salesforce ✅
[SNAPSHOT] Complete ✅ orgId=00D...
[STEP:Account] SUMMARY ✅ ok=20 errors=0 elapsed=3,200 ms
[STEP:Contact] SUMMARY ✅ ok=20 errors=0 elapsed=2,100 ms
[STEP:Opportunity] SUMMARY ✅ ok=20 errors=0 elapsed=4,400 ms
[System] Completed ✅ total=12,500 ms
```

Check `logs/run-<timestamp>.log` for the full run report.

**Re-running** the same pipeline performs upserts — existing records are updated, no duplicates are created.

---

### Adding a Custom Object Step

1. Add your seed records to a JSON file (or an existing seed file under a new key)
2. Create a mapping config (e.g., `config/myproject/mappings/MyObject__c.json`)
3. Add a step to `config/pipeline.json`:

```json
{
  "object": "MyObject__c",
  "dataFile": "./config/myproject/data/seed.json",
  "dataKey": "MyObject__c",
  "mode": "direct",
  "configFile": "./config/myproject/mappings/MyObject__c.json",
  "dependsOn": ["Account"]
}
```

4. Run: `npm start`

---

## License

Apache 2.0. See [LICENSE](LICENSE) for details.
