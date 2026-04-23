## 1. Database module scaffolding

- [x] 1.1 Confirm `@electric-sql/pglite` resolves via `npm ls @electric-sql/pglite --prefix server` — no new dependency install required.
- [x] 1.2 Create `data/pglite/.gitkeep` (empty file) and verify `.gitignore` already has `data/pglite/*` + `!data/pglite/.gitkeep` (confirmed present).
- [x] 1.3 Create `server/src/db/` tree: keep existing `migrations/` folder; add empty `index.ts`, `types.ts`, `migrate.ts`, and `migrations/0001_initial.sql`.

## 2. Schema migration (0001_initial.sql)

- [x] 2.1 Write `tickets` table: `external_id TEXT PRIMARY KEY, title TEXT NOT NULL, ac_text TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
- [x] 2.2 Write `workflow_runs` table: `id UUID PRIMARY KEY, workflow_id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL REFERENCES tickets(external_id) ON DELETE RESTRICT, status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ`.
- [x] 2.3 Write `attempts` table with `UNIQUE (run_id, phase, attempt_index)` and CHECK on `phase` ∈ `('spec','code','review')`, `outcome` ∈ `('pending','passed','failed','stuck')`, and `attempt_index >= 0`. FK `run_id REFERENCES workflow_runs(id) ON DELETE CASCADE`.
- [x] 2.4 Write `reviews` table with `UNIQUE (attempt_id, persona)`, CHECK on `persona` ∈ `('security','performance','architect','naming')` and `vote` ∈ `('approve','reject','abstain')`. FK `attempt_id REFERENCES attempts(id) ON DELETE CASCADE`.
- [x] 2.5 Write `provenance` table: `hash TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, model TEXT NOT NULL, ticket_id TEXT NULL, attempt_index INTEGER NULL, kind TEXT NOT NULL CHECK (kind IN ('tool_call','tool_result','message','diff')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`. No FK to `tickets` (intentional — see design D3).
- [x] 2.6 Add indexes: `CREATE INDEX workflow_runs_ticket_id_idx ON workflow_runs(ticket_id); CREATE INDEX attempts_run_id_idx ON attempts(run_id); CREATE INDEX reviews_attempt_id_idx ON reviews(attempt_id); CREATE INDEX provenance_workflow_id_idx ON provenance(workflow_id); CREATE INDEX provenance_ticket_id_idx ON provenance(ticket_id);`.
- [x] 2.7 Sanity-check the full `0001_initial.sql` by loading it into a scratch PGLite instance from the Node REPL and asserting each `CREATE TABLE` succeeds. (Covered by `db.migrate.test.ts` + `db.schema.test.ts`.)

## 3. Migration runner (server/src/db/migrate.ts)

- [x] 3.1 Export `runMigrations(db: PGlite, migrationsDir: string): Promise<{ applied: string[] }>`.
- [x] 3.2 Ensure `_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())` exists via `CREATE TABLE IF NOT EXISTS`.
- [x] 3.3 Read the directory, filter to `*.sql`, sort lexically.
- [x] 3.4 For each file: `SELECT 1 FROM _migrations WHERE version = $1`; if absent, open a transaction, execute the file's SQL, `INSERT INTO _migrations(version) VALUES ($1)`, commit. On error, rollback and re-throw with the filename in the message.
- [x] 3.5 Return the list of newly applied versions (empty array when the DB is already up-to-date).

## 4. Database handle (server/src/db/index.ts)

- [x] 4.1 Define and export the `Database` interface with `query<T>(sql, params?)`, `exec(sql)`, `transaction<T>(fn)`, `migrate()`, `close()`.
- [x] 4.2 Implement `createDatabase(config: { dataDir?: string }): Promise<Database>`: instantiate `new PGlite(config.dataDir)` if `dataDir` is set, else `new PGlite()`; await `db.waitReady`.
- [x] 4.3 Wrap PGLite's `query`/`exec` to return plain arrays of rows typed to the caller's generic; surface PGLite errors unchanged.
- [x] 4.4 Implement `transaction(fn)` via PGLite's `db.transaction` or manual `BEGIN`/`COMMIT`/`ROLLBACK` if `db.transaction` is absent in the installed version.
- [x] 4.5 Implement `migrate()` as a thin wrapper that calls `runMigrations` with the path `new URL("./migrations/", import.meta.url)` (ESM-friendly resolution).
- [x] 4.6 Implement `close()` delegating to PGLite's `close`.
- [x] 4.7 Export `createDatabase` and the `Database` type from `server/src/db/index.ts`.

## 5. Typed row interfaces (server/src/db/types.ts)

- [x] 5.1 Export `TicketRow`, `WorkflowRunRow`, `AttemptRow`, `ReviewRow`, `ProvenanceRow` with columns matching the migration one-for-one.
- [x] 5.2 Use `Date` for TIMESTAMPTZ, `string` for UUID/TEXT, `number` for INTEGER; mark nullable columns as `T | null`.
- [x] 5.3 Export literal-union types for enum-like columns: `WorkflowRunStatus`, `AttemptPhase`, `AttemptOutcome`, `ReviewPersona`, `ReviewVote`, `ProvenanceKind`. The CHECK constraints in SQL must list the exact same strings.

## 6. App wiring (server/src/app.ts, server/src/index.ts)

- [x] 6.1 Extend `createApp` to accept an optional `{ db }: { db: Database }` argument and set `app.locals.db = db` when provided. Preserve the zero-argument overload for tests that don't need the DB (e.g., `foundation`'s `/health` tests).
- [x] 6.2 Update `server/src/index.ts`: before `createApp()`, construct the DB with a dataDir anchored at the repo root (see design implementation note — `data/pglite/pgdata/` so `.gitkeep` at `data/pglite/.gitkeep` can coexist with PGLite's `initdb`); then `await db.migrate()`; then pass `db` into `createApp`.
- [x] 6.3 Stub the `DATABASE_URL` branch: if set, throw `new Error("prod driver not wired up yet — tracked for the deploy change")`. Keeps the env var reserved without silently misbehaving.
- [x] 6.4 Register a `SIGTERM`/`SIGINT` hook extension that awaits `db.close()` after `server.close()` resolves, before `process.exit(0)`.

## 7. Integration tests (server/tests/integration)

- [x] 7.1 Create `server/tests/integration/db.createDatabase.test.ts`: asserts `createDatabase({})` returns a handle, `SELECT 1 AS n` returns `[{ n: 1 }]`, and no files are written under `data/pglite/` during the test (snapshot dir contents before/after).
- [x] 7.2 Create `server/tests/integration/db.migrate.test.ts`:
  - 7.2.1 Fresh DB: `await db.migrate()` creates `_migrations` and applies `0001_initial`, and `information_schema.tables` shows all six tables.
  - 7.2.2 Idempotence: second `migrate()` call is a no-op, returns `{ applied: [] }`.
  - 7.2.3 Failing migration: write a temporary bogus `.sql` file into a scratch migrations dir, assert the call throws, `_migrations` has no row for the bogus version, and prior migrations remain.
  - 7.2.4 Lexical order: use a scratch migrations dir with `0002_b.sql` and `0001_a.sql`, assert `a` applied before `b`.
- [x] 7.3 Create `server/tests/integration/db.schema.test.ts` per the scenarios in `specs/data-persistence/spec.md`:
  - 7.3.1 Insert a `tickets` row, then a `workflow_runs` row referencing it; second insert with same `workflow_id` is rejected (UNIQUE).
  - 7.3.2 CHECK on `workflow_runs.status = 'bogus'` is rejected.
  - 7.3.3 `attempts` UNIQUE(`run_id`, `phase`, `attempt_index`) rejects duplicate.
  - 7.3.4 `reviews` UNIQUE(`attempt_id`, `persona`) rejects duplicate; CHECK rejects bad `persona` and `vote`.
  - 7.3.5 `provenance` PK on `hash` rejects duplicate; CHECK rejects bad `kind`.
  - 7.3.6 Delete `workflow_runs` row cascades to `attempts` and `reviews`; delete `tickets` row with runs is rejected.
- [x] 7.4 Create `server/tests/integration/db.rowTypeSync.test.ts`: introspects each table via `SELECT column_name FROM information_schema.columns WHERE table_name = $1` and asserts the set of column names equals the set of keys on the exported row interface (build a runtime key map explicitly in the test; no reflection magic).
- [x] 7.5 Create `server/tests/integration/app.dbContext.test.ts`: constructs a test app via `createApp({ db })` with a test-only route mounted that returns `typeof req.app.locals.db`, asserts it is `"object"` and the exact instance is reachable.

## 8. Verification

- [x] 8.1 Run `npm test` at the repo root; all new and existing tests pass with exit 0.
- [x] 8.2 Run `npx tsc --noEmit -p server/tsconfig.json` with zero errors.
- [x] 8.3 Run `npm run dev`, observe migration log line at boot, `curl http://localhost:3000/health` still returns `{ status: "ok", ... }`, then SIGTERM and confirm clean exit (including `db.close()` running).
- [x] 8.4 Inspect `data/pglite/` — PGLite files present (under `pgdata/` subdirectory, see design note), `.gitkeep` present, `git status` shows no untracked files under `data/pglite/` (ignore rule working).

## 9. Changelog and commit

- [x] 9.1 Tick every box above as completed.
- [x] 9.2 Commit with message `feat(data-model): PGLite schema, migration runner, and row types` referencing this change.
- [x] 9.3 Update `openspec/roadmap.md` — mark `data-model` checked, in the same commit or a follow-up.
