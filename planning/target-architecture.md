# Target Architecture — CloudSeeder

**Review Date:** 2026-03-12

---

## 1. Vision Statement

CloudSeeder should be a layered, single-responsibility system where each module owns exactly one concern and communicates through clean, typed interfaces. All Salesforce I/O flows through a dedicated `salesforce/` layer, all record transformations flow through a composable `transform/` pipeline, and all configuration — including environment variables — is validated at startup before any external calls are made. The entry point should be a thin orchestrator (~20 lines) that wires together independently testable modules.

---

## 2. Proposed Folder Structure

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
│   │   └── generators.js           # Generator registry: registerGenerator() / runGenerator()
│   │
│   ├── transform/
│   │   ├── shape.js                # shapeRecord(): fieldMap, defaults, removeFields
│   │   ├── transforms.js           # applyTransforms(): assign, copy, rename, remove, coalesce, concat
│   │   ├── constants.js            # resolveConstantsDeep(): ${constants.*} interpolation
│   │   ├── ref-solver.js           # resolveReferences(): foreign key resolution (moved from mapping/)
│   │   └── index.js                # Re-exports all transform stages
│   │
│   ├── loader.js                   # insertAndMap(): compose transforms + commit (reduced scope)
│   │
│   ├── salesforce/
│   │   ├── auth.js                 # getConnection() (moved from lib/auth.js)
│   │   ├── commit.js               # commit(), commitREST(), commitComposite(), commitBulk()
│   │   ├── metadata.js             # snapshotOrgMetadata(), pruneRecordFields(), validateBatch()
│   │   └── permset.js              # Permission Set management (moved from lib/utils/permset.js)
│   │
│   ├── validators/
│   │   ├── matchkeys.js            # validateMatchKeysFromSnapshots() (renamed from validatematchkeys.js)
│   │   └── schema.js               # validateBatch() extracted from metadata.js
│   │
│   ├── config/
│   │   ├── env.js                  # NEW: loadEnvConfig() — single env var source of truth
│   │   ├── pipeline.js             # loadPipeline()
│   │   ├── constants.js            # loadConstants()
│   │   ├── step-config.js          # loadStepConfig()
│   │   ├── utils.js                # readJSON() (JSON5), deepMerge() (canonical non-mutating)
│   │   └── index.js                # Re-exports
│   │
│   └── utils/
│       ├── logger.js               # Console logger (existing — unchanged)
│       ├── runlog.js               # Per-run file logger (existing — unchanged)
│       ├── duallogger.js           # NEW: createDualLogger() — single call to both loggers
│       ├── retry.js                # NEW: withRetry() exponential backoff
│       └── runcontext.js           # Org ID store (moved from lib/runcontext.js)
│
├── services/
│   └── generators.js               # Domain-specific generators (BKAI examples; register via registry)
│
├── config/                         # User configuration (unchanged)
│   ├── pipeline.json
│   ├── constants.json
│   ├── base/
│   └── env/<env>/
│
├── meta-data/                      # (generated) org describe cache
└── logs/                           # (generated) run logs
```

---

## 3. Module Responsibility Map

| Module | Owns | Does NOT Own |
|---|---|---|
| `scripts/runLoad.js` | Process entry: env init, auth, invoke orchestrator, top-level error/exit | Step logic, config loading, Salesforce calls |
| `lib/pipeline/orchestrator.js` | Step execution loop, idMap accumulation, run report | Transform logic, Salesforce I/O, config loading |
| `lib/pipeline/toposort.js` | Topological sort of steps by `dependsOn` — pure, no I/O | Everything else |
| `lib/pipeline/dataloader.js` | Load and memoize JSON/JSON5 seed data files | Parsing, transforms, Salesforce I/O |
| `lib/pipeline/generators.js` | Generator registry: `registerGenerator()`, `runGenerator()` | Generator implementations (those live in `services/`) |
| `lib/transform/shape.js` | Apply `fieldMap`, `defaults`, `removeFields` to a single record | Salesforce I/O, config loading |
| `lib/transform/transforms.js` | Execute assign / copy / rename / remove / coalesce / concat operations | Record sourcing, Salesforce I/O |
| `lib/transform/constants.js` | Interpolate `${constants.*}` placeholders | Loading constants (receives them as argument) |
| `lib/transform/ref-solver.js` | Resolve declarative foreign key references using idMaps | Loading idMaps (receives them as argument) |
| `lib/loader.js` | Compose full transform pipeline + prune + assert + batch + commit for one object | Orchestration, config loading, generator dispatch |
| `lib/salesforce/auth.js` | Create authenticated jsforce connection | Env reading (receives config as argument) |
| `lib/salesforce/commit.js` | Route to REST / Composite / Bulk commit strategy; return normalized result | Transform logic, idMap management |
| `lib/salesforce/metadata.js` | Snapshot org describe, cache to disk, load from cache, prune record fields | Record transforms, commit logic |
| `lib/salesforce/permset.js` | Create Permission Sets, grant FLS, assign to users | Match key validation logic |
| `lib/validators/matchkeys.js` | Validate mapping matchKey fields exist in org; auto-create if configured | Field pruning, commit dispatch |
| `lib/validators/schema.js` | Validate record fields against org describe (post-prune gate) | Pruning, transform logic |
| `lib/config/env.js` | Read, validate, and export all environment variables as typed object | Business logic of any kind |
| `lib/config/pipeline.js` | Load `pipeline.json` with env overlay | Step execution |
| `lib/config/constants.js` | Load `constants.json` with env overlay | Constants interpolation |
| `lib/config/step-config.js` | Load + 4-layer-merge object mapping config (cached) | Transform execution |
| `lib/config/utils.js` | Shared `readJSON` (JSON5) and canonical `deepMerge` | Config-specific loading logic |
| `lib/utils/logger.js` | Level-gated, timestamped console logging | File logging, business logic |
| `lib/utils/runlog.js` | Per-run append-mode file logging | Console logging, business logic |
| `lib/utils/duallogger.js` | Route a single log call to both console and file loggers | Log formatting, level gating |
| `lib/utils/retry.js` | Exponential backoff wrapper for async operations | Business/domain logic |
| `lib/utils/runcontext.js` | Process-lifetime org ID store | Any other state |
| `services/generators.js` | Domain-specific data generators (BKAI examples) | Pipeline orchestration, Salesforce I/O |
| `lib/filters.js` | Evaluate declarative filter predicates against records | Data loading, Salesforce I/O |

---

## 4. Layered Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      CLI Entry Point                             │
│                   scripts/runLoad.js                             │
│    env init · auth · invoke orchestrator · top-level catch       │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                   Pipeline Orchestrator                           │
│              lib/pipeline/orchestrator.js                        │
│    step loop · toposort · snapshot · match key validation ·      │
│    run report · idMap accumulation                               │
└──────────┬───────────────────────────────┬────────────────────────┘
           │                               │
┌──────────▼──────────┐       ┌────────────▼────────────────────────┐
│   Data Pipeline     │       │       Generator Dispatch             │
│   lib/loader.js     │       │   lib/pipeline/generators.js        │
│                     │       │   services/generators.js            │
│   shape → pre →     │       └─────────────────────────────────────┘
│   refs → post →     │
│   prune → assert →  │
│   unique → batch    │
└──────────┬──────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                     Transform Layer                              │
│   lib/transform/shape.js   ·  transforms.js  ·  constants.js    │
│   lib/transform/ref-solver.js              ·  lib/filters.js    │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                  Salesforce API Layer                            │
│   lib/salesforce/commit.js    (REST · Composite · Bulk 2.0)     │
│   lib/salesforce/metadata.js  (describe · prune)                │
│   lib/salesforce/auth.js      (jsforce connection)              │
│   lib/salesforce/permset.js   (FLS · Permission Sets)           │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│               Config & Validation Layer                          │
│   lib/config/env.js  ·  pipeline.js  ·  constants.js            │
│   lib/config/step-config.js  ·  utils.js  (JSON5 · deepMerge)   │
│   lib/validators/matchkeys.js  ·  schema.js                     │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                   Infrastructure Layer                           │
│   lib/utils/logger.js     (console · level-gated · timestamped) │
│   lib/utils/runlog.js     (per-run file · append-mode)          │
│   lib/utils/duallogger.js (single call → console + file)        │
│   lib/utils/retry.js      (exponential backoff · retryOn pred.) │
│   lib/utils/runcontext.js (org ID store)                        │
└─────────────────────────────────────────────────────────────────┘
```

**Layer rule:** A module may only import from the same layer or a layer below it. No upward dependencies. The CLI entry point may import from any layer.

---

## 5. Design Patterns to Adopt

### Strategy Pattern — Commit Strategies

**Description:** Define a family of algorithms (commit strategies), encapsulate each, and make them interchangeable behind a common interface.

**Why it fits CloudSeeder:** `lib/sf.js` already implements three commit strategies (`commitREST`, `commitComposite`, `commitBulk`) dispatched by `strategy.api`. This is the Strategy pattern in spirit — it just has a broken interface contract (`commitComposite` returns a different shape).

**Which current code it replaces:** `lib/sf.js` / `lib/salesforce/commit.js` dispatch logic.

**Pseudocode:**
```js
// lib/salesforce/commit.js
const STRATEGIES = {
  rest:      commitREST,
  composite: commitComposite,  // fixed to return normalized shape
  bulk:      commitBulk,
};

// Uniform return: { operation, created[], updated[], failures[], processedRecords[] }
export async function commit(conn, objectName, batch, strategy) {
  const fn = STRATEGIES[strategy.api] ?? commitREST;
  return fn(conn, objectName, batch, strategy);
}
```

---

### Pipeline Pattern — Composable Transform Chain

**Description:** Process data through a sequence of composable stages, each with the same signature.

**Why it fits CloudSeeder:** The transform sequence (constants → pre → shape → refs → post → prune → validate) is already a conceptual pipeline. Currently these are sequential imperative calls inside `loader.js`. Formalizing the pipeline allows stages to be reordered, skipped, or extended without modifying the loop.

**Which current code it replaces:** The per-record transform loop in `lib/loader.js`.

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

### Registry Pattern — Generator Extensibility

**Description:** Maintain a named registry of functions that can be looked up and invoked by name at runtime.

**Why it fits CloudSeeder:** `services/generators.js` hard-codes domain-specific generators. New generators require editing library source code. A registry allows users to register generators from outside the library without modifying it.

**Which current code it replaces:** The direct object map in `services/generators.js`.

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

// services/generators.js (domain generators registered at startup)
import { registerGenerator } from '../lib/pipeline/generators.js';
registerGenerator('generateShiftPatterns', (data, idMaps) => { ... });
```

---

## 6. What Success Looks Like

The target architecture is achieved when all of the following are true:

- [ ] **No minified source files** — zero `.min.js` files exist in `lib/`
- [ ] **`scripts/runLoad.js` is ≤ 30 lines** — entry point delegates to orchestrator; no business logic inline
- [ ] **All Salesforce calls go through `lib/salesforce/`** — no `conn.*` calls outside of `lib/salesforce/auth.js`, `commit.js`, `metadata.js`, or `permset.js`
- [ ] **Config is validated at startup** — a missing or invalid env var produces a clear error before any Salesforce call is made
- [ ] **Single env var source of truth** — `process.env` is read only in `lib/config/env.js`; all other modules receive config as arguments
- [ ] **Single `deepMerge` implementation** — one canonical function in `lib/config/utils.js`, imported everywhere
- [ ] **Single JSON parser** — JSON5 used in all config and mapping file reads
- [ ] **`LOG_PRUNE=true` works without error** — the `ReferenceError` bug is fixed
- [ ] **`"api": "composite"` works without error** — `commitComposite` returns normalized shape
- [ ] **All log statements are single calls** — no manual dual-write; `createDualLogger` used throughout
- [ ] **Transient API failures are retried** — bulk commits and login use `withRetry` with sensible defaults
- [ ] **Generators are registered, not imported** — new generators can be added without modifying library source
- [ ] **No `console.*` calls in library code** — all logging goes through `lib/utils/logger.js` or `duallogger.js`
- [ ] **Connection is closed on run completion** — `conn.logout()` called in success and error paths
