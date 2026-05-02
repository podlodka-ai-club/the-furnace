## Why

The PGLite-backed orchestrator database is causing more outage than it prevents. Today it is bricking workflows: a single transient `_pg_initdb` abort in PGLite's WASM rejects the cached `dbPromise` for the lifetime of the orchestrator process, so every subsequent `persistWorkflowRunStart` activity fails the same way and per-ticket workflows never reach `launchWorkerContainer`. The data we persist (`workflow_runs`, `attempts`, plus an empty `tickets` shadow) duplicates information Temporal already owns in workflow history and search attributes, and no consumer downstream reads it. The unused tables (`reviews`, `provenance`) belong to capabilities that haven't been built yet (`review-agent`, `vote-aggregator`, `provenance-store`); when those land they will pick a real datastore on their own terms (Postgres, content-addressed blob store) instead of inheriting an in-process WASM DB that doesn't survive worker restarts. Roadmap Phase 7 already lists `pglite-drop` as a chore; the recent incident promotes it.

## What Changes

- **BREAKING** Remove the orchestrator-side database entirely. Delete the `data-persistence` capability, the `server/src/db/` tree (factory, migrate, types, migrations, orchestrator singleton, tickets reader), the `data/pglite/` directory, and the `@electric-sql/pglite` dependency.
- **BREAKING** Remove the `persistWorkflowRunStart`, `persistWorkflowRunTransition`, and `recordAttempt` orchestrator activities and their wiring in `PerTicketWorkflow`. Workflow lifecycle and attempt outcomes are observed via Temporal's own history, status, and search attributes; no orchestrator-side row is written.
- Drop the corresponding requirements from `ticket-workflow` (workflow-run persistence and `attempts`-row recording around the spec phase). The `cancel` signal, phase ordering, query handlers, and `AcClarificationRequested` handling stay; they don't depend on the DB.
- Strip database wiring from the dev server entry point in `server/src/index.ts`: no `createDatabase`, no `db.migrate()`, no `app.locals.db`. The `/health` endpoint stays as-is. (A separate roadmap item, `server-unused`, may delete the Express server entirely; this change does not pre-empt that decision.)
- Update READMEs/AGENTS/CLAUDE notes that reference PGLite, `data/pglite/`, `DATABASE_URL`, or DB migrations so they don't lie. Keep the "PGLite for dev/test, Postgres for prod" wording out of CLAUDE.md until a replacement actually exists.
- Delete the DB integration tests (`db.*.test.ts`, `app.dbContext.test.ts`) and the DB-dependent assertions inside `temporal.ticketWorkflows.test.ts` / `container-lifecycle.test.ts`. Tests that need to assert "this attempt failed" should observe Temporal history instead of querying a SQL row.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `data-persistence`: every requirement is removed. The capability ceases to exist as part of this change.
- `ticket-workflow`: the "Workflow Records Attempts Row Around Spec Phase" and "Workflow Runs Are Persisted On Start and Phase Transitions" requirements are removed. All other requirements (phase ordering, AC clarification pause, cancel signal, phase/attempt queries) remain unchanged.

## Impact

- **Code removed**: `server/src/db/**`, `server/src/temporal/activities/workflow-runs.ts`, `server/src/temporal/activities/attempts.ts`, related test files, and the DB-construction block in `server/src/index.ts`.
- **Code modified**: `server/src/temporal/workflows/per-ticket.ts` (drop persist/recordAttempt calls), `server/src/temporal/worker.ts` (drop the activity registrations), `package.json` (remove `@electric-sql/pglite`).
- **APIs**: no external API changes; `/health` is unchanged. Internal Temporal activities listed above disappear.
- **Filesystem**: `data/pglite/` is removed from the repo. `.gitignore` and `data/.gitkeep` updated accordingly.
- **Operator-facing**: workflow-run status and attempt outcomes are now read from Temporal Web UI / `temporal workflow describe` rather than from any local SQL store. Operators who today grep `data/pglite/` for state must switch to Temporal queries — there is no persisted SQL row to fall back on.
- **Future capabilities**: `review-agent`, `vote-aggregator`, and `provenance-store` will need to introduce their own storage decisions (likely Postgres for relational state, object store for provenance blobs). They are not blocked by this change because none of them currently reads or writes the dropped tables.
- **Risk**: the only thing the orchestrator DB was authoritatively buying us was a place to look up "did attempt N pass?" without replaying Temporal history. We accept that loss for now; if it bites in practice, the replacement is a real Postgres in a follow-up change, not a return to in-process PGLite.
