## Context

`foundation` stood up an Express app with `/health` and a testable `createApp()`. Nothing persistent exists yet. Every subsequent change on the roadmap needs a database:

- `temporal-setup` writes one row per workflow execution.
- `linear-integration` caches Linear tickets so a workflow can replay deterministically without re-hitting the API.
- `per-ticket-workflow` records phase transitions (spec → code → review) and per-attempt outcomes.
- `persona-reviewers` + `vote-aggregator` persist per-persona votes and reasoning.
- `provenance-store` maps content-addressed hashes to the workflow metadata that produced them.

Constraints:

- **PGLite locally, Postgres in prod** (CLAUDE.md). All SQL must be PostgreSQL syntax; no SQLite-only functions (`STRICT`, `WITHOUT ROWID`, `AUTOINCREMENT`), no Postgres-only features PGLite doesn't yet support (`pg_trgm`, stored procedures, `LISTEN/NOTIFY` at startup).
- **Never require a running Postgres for dev** — PGLite lives in-process.
- **Integration tests hit the real database**, not mocks (CLAUDE.md).
- **No new dependencies outside an approved proposal.** `@electric-sql/pglite` is already in `server/package.json`; no driver swap here. The prod path reads `DATABASE_URL` and uses PGLite's `pglite-socket` or we defer the prod driver choice to the deploy change — this proposal keeps the abstraction narrow enough to swap later.
- Strict TypeScript, no `any`.

The database module must boot before Temporal workers register, before Express routes that need DB state are mounted, and before integration tests run. It must be trivial to reset between tests.

## Goals / Non-Goals

**Goals:**

- A single `createDatabase(config)` factory in `server/src/db/index.ts` returning a typed handle with `query`, `exec`, `close`, and `migrate` methods, backed by PGLite.
- A deterministic migration runner that applies `server/src/db/migrations/NNNN_*.sql` files in lexical order inside a transaction per file, tracked by a `_migrations` bookkeeping table.
- Migration `0001_initial.sql` creating `workflow_runs`, `tickets`, `attempts`, `reviews`, `provenance` with the foreign keys and indexes that the roadmap's downstream changes will exercise.
- TypeScript row types in `server/src/db/types.ts` that mirror each table column-for-column.
- Integration tests that boot a fresh in-memory PGLite per test, run migrations, and assert schema + constraint behavior.
- `data/pglite/` stays on disk in dev, gitignored except for `.gitkeep`.

**Non-Goals:**

- A query builder or ORM. We write SQL. Kysely/Drizzle are a later proposal if raw SQL friction becomes real.
- A `/ready` endpoint. `foundation` deliberately deferred it; this change will only add the DB handle to the app context — wiring `/ready` to the DB health belongs to whichever change first needs liveness-vs-readiness separation (likely `temporal-setup`).
- Schema for Temporal internals (Temporal owns its own storage), persona prompt tuning data, or provenance blob storage. Only the *metadata indexes* land here; blobs are `provenance-store`'s problem.
- A migration *rollback* runner. Forward-only migrations; if a dev makes a bad one they drop `data/pglite/` and re-run. Prod rollback is a `temporal-setup`/deploy concern, not this change's.
- Seed data. Tests seed per-test; there is no shared seed fixture.
- Connection pooling abstraction. PGLite is in-process and single-connection by nature; a real pool shows up with the prod Postgres driver, which is a later change.

## Decisions

### D1. PGLite directly, behind a narrow `Database` interface

`createDatabase({ dataDir?: string })` returns an object conforming to:

```ts
interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
```

When `dataDir` is omitted, PGLite runs fully in-memory (`new PGlite()`); when provided, it persists under that path (`new PGlite(dataDir)`). Dev uses `data/pglite/`; tests use in-memory; prod reads `DATABASE_URL` and, for now, falls through to a clearly-thrown `NotImplementedError` — prod wiring lands with whichever change first deploys the system.

**Why:** The concrete driver is PGLite *today* but will likely be `pg` in prod. A narrow interface keeps call sites driver-agnostic; later changes can add a `pg`-backed implementation behind the same shape without touching every caller. Avoiding a full ORM now prevents the "every subsequent change drags in query-builder patterns" failure mode.

**Alternative considered:** Import the PGLite `PGlite` class directly at every call site. Rejected — swapping to `pg` in prod would then require editing every consumer. The interface is ~30 lines and earns its keep the first time we change drivers.

**Alternative considered:** Introduce Kysely or Drizzle now. Rejected — neither is in `server/package.json`, adding them to this proposal expands scope, and we don't yet know which tables will grow gnarly enough to need typed query building. Raw SQL with hand-written row types is boring and replaceable.

### D2. Forward-only, file-based migrations tracked by `_migrations`

Migrations are SQL files under `server/src/db/migrations/` named `NNNN_description.sql` where `NNNN` is a zero-padded integer. The runner:

1. Ensures `_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())` exists.
2. Reads filenames, sorts lexically, filters out ones already in `_migrations`.
3. For each remaining file: begins a transaction, runs the SQL, inserts its version into `_migrations`, commits. Any failure rolls the transaction back and throws.

**Why:** The simplest contract that survives multi-dev collaboration. Lexical filename order avoids the "which timestamp format?" bikeshed. Per-file transactions mean a bad migration leaves the DB exactly as it was, not half-migrated. The `_migrations` table is standard; later adopting `node-pg-migrate` or `umzug` would import this exact shape.

**Alternative considered:** Use an existing migration library (`node-pg-migrate`, `umzug`). Rejected — new dependency outside the proposal's approved list, and the runner we need is ~40 lines. Drop-in replacement cost is low if we outgrow it.

**Alternative considered:** Timestamp-prefixed migration files (`20260423120000_initial.sql`). Rejected — two devs authoring migrations simultaneously still collide, and the sort behavior is identical to zero-padded integers. Integers are easier to read.

**Alternative considered:** Inline the schema in TypeScript (`db.exec(schema)` at boot). Rejected — it prevents adding migration #2 without editing the same string, eliminates migration state tracking, and makes prod/dev parity ambiguous. Files are the boring correct answer.

### D3. Schema shape and foreign keys

Tables land in `0001_initial.sql` as:

```
workflow_runs (
  id            UUID PRIMARY KEY,
  workflow_id   TEXT NOT NULL UNIQUE,           -- Temporal's workflow id
  ticket_id     TEXT NOT NULL REFERENCES tickets(external_id) ON DELETE RESTRICT,
  status        TEXT NOT NULL CHECK (status IN
                  ('pending','running','succeeded','failed','cancelled')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
)

tickets (
  external_id   TEXT PRIMARY KEY,               -- Linear identifier e.g. ENG-123
  title         TEXT NOT NULL,
  ac_text       TEXT NOT NULL,                  -- acceptance criteria body
  label         TEXT NOT NULL,                  -- e.g. 'agent-ready'
  state         TEXT NOT NULL,                  -- Linear workflow state
  cached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

attempts (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  phase         TEXT NOT NULL CHECK (phase IN ('spec','code','review')),
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
  outcome       TEXT NOT NULL CHECK (outcome IN ('pending','passed','failed','stuck')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (run_id, phase, attempt_index)
)

reviews (
  id          UUID PRIMARY KEY,
  attempt_id  UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  persona     TEXT NOT NULL CHECK (persona IN
                ('security','performance','architect','naming')),
  vote        TEXT NOT NULL CHECK (vote IN ('approve','reject','abstain')),
  reasoning   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, persona)
)

provenance (
  hash           TEXT PRIMARY KEY,                -- sha256 of the content-addressed blob
  workflow_id    TEXT NOT NULL,                   -- Temporal workflow id (not FK; outlives run)
  model          TEXT NOT NULL,                   -- e.g. 'claude-opus-4-7'
  ticket_id      TEXT,                            -- nullable: some outputs aren't ticket-scoped
  attempt_index  INTEGER,
  kind           TEXT NOT NULL CHECK (kind IN ('tool_call','tool_result','message','diff')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Supporting indexes: `workflow_runs(ticket_id)`, `attempts(run_id)`, `reviews(attempt_id)`, `provenance(workflow_id)`, `provenance(ticket_id)`.

**Why UUIDs for internal ids, TEXT for external ids:** Linear ticket ids are semantic (`ENG-123`) and human-searchable; using them as PKs in `tickets` keeps caching trivially idempotent. Internal entities (`workflow_runs`, `attempts`, `reviews`) use UUIDs generated server-side so a Temporal workflow can create an `attempts` row without a round-trip to reserve a serial id.

**Why CHECK constraints over enum types:** PGLite's enum support has historically been the rough edge. CHECK constraints on TEXT columns are universally portable and equally enforced. Swapping to real `CREATE TYPE ... AS ENUM` is a later migration if needed.

**Why `ON DELETE CASCADE` from `attempts → reviews`, `runs → attempts`:** Deleting a workflow run is a dev-time operation; cascading keeps orphan rows from accumulating. `workflow_runs.ticket_id` is `ON DELETE RESTRICT` because we should never drop a ticket we have runs for — that would erase provenance.

**Why `provenance.workflow_id` is not an FK:** `provenance` rows outlive the workflow run record (runs can be pruned for disk; provenance hashes are durable). Keeping it as a plain index preserves the content-address-as-truth property — `provenance-store` can later introduce blob storage and the hash remains the stable key.

**Alternative considered:** Single `events` table with a JSON payload column per event kind. Rejected — loses CHECK-level integrity on phase/outcome/vote enums, pushes query complexity into every reader, and forfeits the per-table indexes downstream changes will need.

**Alternative considered:** Separate per-persona review tables. Rejected — four identical schemas differing only by CHECK constraint is the textbook case for a single table with a discriminator.

### D4. Row types generated by hand, colocated with migration

`server/src/db/types.ts` exports one interface per table with columns typed as TypeScript primitives (`Date` for `TIMESTAMPTZ`, `string` for `TEXT`/`UUID`, `number` for `INTEGER`, nullable where the column is `NULL`-able). A single code review gate keeps them in sync with `0001_initial.sql`.

**Why:** Auto-generated types from `pg_dump` or introspection are a toolchain dependency we don't yet have, and the table count is ~5. When it grows past ~15 or diverges in practice, introducing `kysely-codegen`-style introspection is its own proposal.

### D5. `Database` is owned by the process, threaded via app-context

`createApp()` grows a second overload: `createApp({ db }: { db: Database }): Express`. Routes that need the DB read it off `req.app.locals.db`. The entry point (`server/src/index.ts`) constructs the DB, runs migrations, then constructs the app, then starts listening. Tests construct a per-test in-memory DB, run migrations, and pass it to `createApp`.

**Why:** Keeps the DB handle out of module-level globals — essential for parallel test runs and for the future where `temporal-setup` wants multiple app instances (e.g., worker vs. control plane) sharing one DB. Mirrors the `foundation` decision to keep `createApp` pure and test-friendly.

**Alternative considered:** A module-level singleton (`import { db } from './db'`). Rejected — defeats per-test isolation, makes `createApp()` impure, and forces a global side effect on import.

### D6. `createDatabase` is async; migrations run explicitly, not on construct

Callers must `await createDatabase(...)` followed by `await db.migrate()`. No hidden boot work. Any call site that forgets migrations fails loudly the first time a table is queried.

**Why:** "Migrations on boot" hides startup errors inside the DB constructor and makes integration tests slower (every `createDatabase` re-applies the same migrations instead of sharing a warmed schema). Explicit migration calls let tests use an in-memory instance and decide whether to migrate or not.

## Risks / Trade-offs

- **Risk:** PGLite and Postgres drift on a SQL feature we use. → **Mitigation:** A CI integration-test lane later runs the same test suite against a real Postgres container (not in this change; tracked as a `temporal-setup`-era concern). For now, stick to ANSI SQL plus `TIMESTAMPTZ`, `UUID`, `CHECK`, which PGLite fully supports.
- **Risk:** Hand-written row types drift from migration SQL. → **Mitigation:** An integration test asserts that every column in every migration table appears in the exported row type (via a runtime schema introspection query comparing column sets). When the check fails, a human updates `types.ts`.
- **Risk:** Forward-only migrations mean a botched migration in prod has no automatic rollback. → **Accepted for now.** PGLite dev mode is "delete `data/pglite/` and re-run." Prod rollback is a deploy-time concern and lands with whichever change first deploys to prod — probably `temporal-setup` or a later ops change. Flagged here so it isn't lost.
- **Risk:** `provenance.ticket_id` as nullable TEXT without an FK allows pointing at a non-existent ticket. → **Accepted.** `provenance` is intentionally an append-only log keyed by content hash, not a referential graph. Enforcing FK here would block writing provenance before the `tickets` row is cached, which inverts the desired ordering.
- **Risk:** UUID generation source. PGLite supports `gen_random_uuid()`; if the prod driver needs an extension (`pgcrypto`) that differs from PGLite's built-in, the migration silently diverges. → **Mitigation:** `0001_initial.sql` uses application-side UUIDs (pass `crypto.randomUUID()` from Node in `INSERT`s), not SQL-side generation. Keeps the migration portable.
- **Trade-off:** No `updated_at` or soft-delete columns. → **Accepted.** Downstream changes add them per-table as their workflows demand. Pre-adding columns "just in case" violates the project's no-speculative-design rule.
- **Trade-off:** Tests run migrations from scratch each time instead of templating a migrated DB. → **Accepted.** PGLite in-memory construction + five migrations is milliseconds; the test isolation is worth the cost. Revisit if the suite grows visibly slow.
- **Implementation note (added during apply):** PGLite's `initdb` refuses to run in a non-empty directory, but the spec requires `data/pglite/.gitkeep` to be tracked. Resolution: `server/src/index.ts` passes `data/pglite/pgdata` as the PGLite `dataDir`. `.gitkeep` lives at `data/pglite/.gitkeep`; PGLite's files live one level deeper at `data/pglite/pgdata/`. The gitignore rule (`data/pglite/*` + `!data/pglite/.gitkeep`) covers the subdirectory. Observable behavior for downstream changes (persistence across restarts, gitignore) is unchanged.
