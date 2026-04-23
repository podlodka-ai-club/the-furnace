## Why

Tickets, attempts, reviews, and provenance all need a shared persistent schema before the orchestration substrate can be wired. PGLite locally keeps the dev loop hermetic; the same PostgreSQL-compatible SQL runs against Postgres in production.

## What Changes

- Initialize PGLite in `server/src/db/index.ts` with a configurable data directory (`data/pglite/` in dev, `$DATABASE_URL` in prod).
- Add SQL migration runner that applies files from `server/src/db/migrations/` in lexical order.
- Add initial migrations for the core tables:
  - `workflow_runs` — one row per Temporal workflow execution (workflow_id, ticket_id, status, started_at, finished_at).
  - `tickets` — cached Linear ticket metadata (external_id, title, ac_text, label, state).
  - `attempts` — one row per spec/code attempt (run_id, phase, attempt_index, outcome).
  - `reviews` — one row per persona vote (attempt_id, persona, vote, reasoning).
  - `provenance` — content-address → workflow metadata index (hash, workflow_id, model, ticket_id, attempt_index, kind).
- Export TypeScript row types mirroring each table.

## Capabilities

### New Capabilities

- `data-persistence`: PGLite/Postgres-portable schema, migration runner, and typed row interfaces for the orchestration core.

### Modified Capabilities

(none)

## Impact

- New: `server/src/db/index.ts`, `server/src/db/migrations/0001_initial.sql`, `server/src/db/types.ts`, integration tests against an in-memory PGLite instance.
- `data/pglite/` remains gitignored except for `.gitkeep`.
- All SQL must be PostgreSQL syntax portable between PGLite and Postgres — no SQLite-only features.
