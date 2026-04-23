## ADDED Requirements

### Requirement: Database factory produces a migrated, typed handle

The system SHALL expose `createDatabase(config: { dataDir?: string }): Promise<Database>` from `server/src/db/index.ts`. The returned `Database` SHALL be a typed handle backed by PGLite with `query`, `exec`, `transaction`, `migrate`, and `close` methods. When `dataDir` is omitted, the database SHALL run in-memory with no filesystem writes; when provided, it SHALL persist to that directory.

#### Scenario: In-memory database is created without touching disk

- **WHEN** `createDatabase({})` is called in a test with `dataDir` omitted
- **THEN** the call resolves to a `Database` instance, no files are created under `data/pglite/`, and `await db.query("SELECT 1 AS n")` returns `[{ n: 1 }]`

#### Scenario: Persistent database writes to the configured dataDir

- **WHEN** `createDatabase({ dataDir: <tempDir> })` is called
- **THEN** PGLite initializes storage under `<tempDir>`, and a subsequent `createDatabase({ dataDir: <tempDir> })` call sees tables created by the first instance after `migrate()` has run

#### Scenario: Factory is pure across calls

- **WHEN** `createDatabase` is called twice with distinct `dataDir` values (or both omitted)
- **THEN** each call returns a distinct `Database` instance whose connections do not share state

### Requirement: Migration runner applies SQL files forward-only in lexical order

The system SHALL apply migration SQL files from `server/src/db/migrations/` in lexical filename order exactly once each. The runner SHALL track applied versions in a `_migrations` bookkeeping table with columns `version TEXT PRIMARY KEY` and `applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`. Each migration file SHALL execute inside a single transaction; a failure SHALL roll back the transaction and leave the `_migrations` table unchanged for that version.

#### Scenario: Fresh database applies all pending migrations

- **WHEN** `db.migrate()` is called on a database with no `_migrations` table
- **THEN** the runner creates `_migrations`, applies every `.sql` file under `server/src/db/migrations/` in lexical order, and inserts one row per applied file into `_migrations`

#### Scenario: Already-applied migrations are skipped

- **WHEN** `db.migrate()` is called a second time on a database that has already applied all migrations
- **THEN** the runner reads `_migrations`, finds no pending files, issues no DDL, and returns without error

#### Scenario: Failing migration leaves the database unchanged

- **WHEN** a migration file contains an invalid SQL statement and `db.migrate()` is called
- **THEN** the runner throws an error, the failing migration's transaction is rolled back, no row is inserted into `_migrations` for that version, and prior migrations' `_migrations` rows remain intact

#### Scenario: Migration order is lexical, not chronological

- **WHEN** the migrations directory contains `0002_b.sql` and `0001_a.sql` (filesystem `mtime` unrelated to filename)
- **THEN** `0001_a.sql` is applied before `0002_b.sql`

### Requirement: Initial schema defines the core orchestration tables

The system SHALL provide `server/src/db/migrations/0001_initial.sql` that creates the tables `workflow_runs`, `tickets`, `attempts`, `reviews`, and `provenance` with the columns, constraints, and foreign keys described below. The migration SHALL use only PostgreSQL-portable syntax that PGLite supports (`UUID`, `TEXT`, `INTEGER`, `TIMESTAMPTZ`, `CHECK`, `REFERENCES`, `UNIQUE`).

#### Scenario: Core tables exist after migration

- **WHEN** `db.migrate()` completes on a fresh database
- **THEN** querying `information_schema.tables` returns rows for each of `workflow_runs`, `tickets`, `attempts`, `reviews`, `provenance`, and `_migrations`

#### Scenario: workflow_runs row shape is enforced

- **WHEN** a row is inserted into `workflow_runs` with `id` (UUID), `workflow_id` (TEXT unique), `ticket_id` referencing an existing `tickets.external_id`, `status` in `('pending','running','succeeded','failed','cancelled')`, `started_at` TIMESTAMPTZ, and optional `finished_at`
- **THEN** the insert succeeds, and inserting a second row with the same `workflow_id` fails the UNIQUE constraint

#### Scenario: workflow_runs.status CHECK constraint rejects invalid values

- **WHEN** an INSERT attempts to set `workflow_runs.status = 'bogus'`
- **THEN** the INSERT is rejected by the CHECK constraint

#### Scenario: tickets uses Linear external_id as primary key

- **WHEN** two rows are inserted into `tickets` with the same `external_id`
- **THEN** the second insert is rejected by the primary key constraint

#### Scenario: attempts enforces phase and outcome enums and uniqueness per (run, phase, attempt)

- **WHEN** a row is inserted into `attempts` with `run_id` referencing an existing `workflow_runs.id`, `phase` in `('spec','code','review')`, `attempt_index >= 0`, and `outcome` in `('pending','passed','failed','stuck')`
- **THEN** the insert succeeds, and a second row with the same `(run_id, phase, attempt_index)` is rejected by the UNIQUE constraint

#### Scenario: reviews enforces persona enum and one vote per persona per attempt

- **WHEN** a row is inserted into `reviews` with `attempt_id` referencing an existing `attempts.id`, `persona` in `('security','performance','architect','naming')`, and `vote` in `('approve','reject','abstain')`
- **THEN** the insert succeeds, and a second row with the same `(attempt_id, persona)` is rejected by the UNIQUE constraint

#### Scenario: provenance is keyed by content hash

- **WHEN** a row is inserted into `provenance` with `hash` (TEXT), `workflow_id` (TEXT), `model` (TEXT), optional `ticket_id` (TEXT), optional `attempt_index` (INTEGER), and `kind` in `('tool_call','tool_result','message','diff')`
- **THEN** the insert succeeds, and a second row with the same `hash` is rejected by the primary key constraint

#### Scenario: Deleting a workflow run cascades to attempts and reviews

- **WHEN** a `workflow_runs` row is deleted that has related `attempts` and `reviews` rows
- **THEN** all `attempts` rows for that run and all `reviews` rows for those attempts are deleted by `ON DELETE CASCADE`

#### Scenario: Deleting a ticket with runs is rejected

- **WHEN** a `tickets` row is deleted while a `workflow_runs` row references it
- **THEN** the delete is rejected by the `ON DELETE RESTRICT` foreign key

### Requirement: Typed row interfaces mirror the schema

The system SHALL export TypeScript interfaces from `server/src/db/types.ts` named `WorkflowRunRow`, `TicketRow`, `AttemptRow`, `ReviewRow`, and `ProvenanceRow`. Each interface SHALL declare one property per column in the corresponding table. Nullable columns SHALL be typed as `T | null`. `TIMESTAMPTZ` columns SHALL be typed as `Date`, `UUID`/`TEXT` as `string`, and `INTEGER` as `number`.

#### Scenario: Row types compile against query results

- **WHEN** a typed query `db.query<WorkflowRunRow>("SELECT * FROM workflow_runs")` is written
- **THEN** `tsc --noEmit` produces zero errors and every non-nullable column appears as a required property

#### Scenario: Row types stay in sync with the schema

- **WHEN** an integration test introspects each table's columns via `information_schema.columns` and compares them to the keys of the corresponding exported row interface
- **THEN** the set of column names matches the set of interface keys with no additions or omissions

### Requirement: Database handle is threaded into the Express app

The system SHALL allow `createApp({ db }: { db: Database })` to mount the database handle on `req.app.locals.db`. The handle SHALL be accessible to route handlers via `req.app.locals.db` without module-level globals. The entry point (`server/src/index.ts`) SHALL construct the database, call `db.migrate()`, and then construct the app.

#### Scenario: Route handler can read the db off app.locals

- **WHEN** a test route handler reads `req.app.locals.db` after the app is constructed via `createApp({ db })`
- **THEN** the value is the exact `Database` instance passed to `createApp`

#### Scenario: Entry point migrates before listening

- **WHEN** `server/src/index.ts` runs and starts the server
- **THEN** migrations complete (all rows in `_migrations` present) before `app.listen()` is called

### Requirement: Dev data directory is persisted under `data/pglite/`

The system SHALL use `data/pglite/` as the default dev `dataDir` when `server/src/index.ts` runs without `DATABASE_URL`. The repository SHALL contain `data/pglite/.gitkeep` and SHALL gitignore the rest of that directory.

#### Scenario: Dev run persists data across restarts

- **WHEN** `npm run dev` starts, a row is inserted into `tickets`, the process is stopped, and `npm run dev` is started again
- **THEN** the previously inserted row is still present on the second boot

#### Scenario: data/pglite is gitignored except for .gitkeep

- **WHEN** `git status --ignored` is run after PGLite has written files under `data/pglite/`
- **THEN** the PGLite files are listed as ignored, `data/pglite/.gitkeep` remains tracked, and no other file under `data/pglite/` appears in tracked changes
