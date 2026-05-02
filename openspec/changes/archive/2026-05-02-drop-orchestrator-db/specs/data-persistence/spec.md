## REMOVED Requirements

### Requirement: Database factory produces a migrated, typed handle

**Reason**: The orchestrator no longer keeps an in-process database. PGLite's WASM `_pg_initdb` aborts have been bricking the orchestrator (one transient init failure poisons the cached `dbPromise` for the lifetime of the worker, blocking every subsequent `persistWorkflowRunStart` activity), and the data we persist is fully shadowed by Temporal's own workflow history and search attributes.

**Migration**: Code that previously called `createDatabase` or read `req.app.locals.db` is deleted. Future capabilities that genuinely need persistence (`review-agent`, `vote-aggregator`, `provenance-store`) introduce their own datastore decisions in their own change proposals. Operators who used the SQL handle for ad-hoc inspection use Temporal Web UI (`localhost:8233`) and `temporal workflow describe` instead.

### Requirement: Migration runner applies SQL files forward-only in lexical order

**Reason**: With no database, there is nothing to migrate. The migrations directory and the `_migrations` bookkeeping table are deleted along with the schema they were applying.

**Migration**: None. The migration runner is removed; no boot step is required to replace it.

### Requirement: Initial schema defines the core orchestration tables

**Reason**: `workflow_runs`, `tickets`, `attempts`, `reviews`, and `provenance` had either no consumer (`reviews`, `provenance`) or were a strictly weaker shadow of Temporal-owned state (`workflow_runs`, `attempts`) and Linear-owned state (`tickets`). Removing the schema removes a substantial liability without dropping any actually-used signal.

**Migration**: None. Local development databases under `data/pglite/pgdata/` are disposable and are deleted as part of the change. Any future capability that needs relational persistence defines its own schema in its own change.

### Requirement: Typed row interfaces mirror the schema

**Reason**: The interfaces (`WorkflowRunRow`, `TicketRow`, `AttemptRow`, `ReviewRow`, `ProvenanceRow`) describe rows from a schema that no longer exists.

**Migration**: All importers of these types are deleted in the same change; there are no remaining references to migrate.

### Requirement: Database handle is threaded into the Express app

**Reason**: The `/health` endpoint never read the database, and no route handler currently reads `req.app.locals.db`. With the database gone, threading it through the app is meaningless.

**Migration**: `createApp` no longer accepts a `db` parameter; the entry point in `server/src/index.ts` no longer constructs a database before constructing the app. The `/health` endpoint is unchanged.

### Requirement: Dev data directory is persisted under `data/pglite/`

**Reason**: There is no PGLite cluster left to persist. The `data/pglite/` directory becomes dead weight and a frequent source of "why are my workflows stuck?" incidents when its WASM init aborts.

**Migration**: `data/pglite/` is removed from the repository. The `.gitignore` entries that scoped it are also removed. Container worker logs continue to live at `data/logs/<attemptId>/`, which is unrelated to the PGLite cluster path being deleted.
