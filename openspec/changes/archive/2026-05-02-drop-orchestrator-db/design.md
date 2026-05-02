## Context

The orchestrator currently runs a singleton PGLite instance behind `getOrchestratorDb()` (`server/src/db/orchestrator.ts`). Three orchestrator-side activities use it: `persistWorkflowRunStart`, `persistWorkflowRunTransition`, and `recordAttempt`. The dev server entry point (`server/src/index.ts`) constructs another `Database` to run migrations and threads it through `app.locals` for `/health`. The schema (`server/src/db/migrations/0001_initial.sql`) defines `workflow_runs`, `tickets`, `attempts`, `reviews`, and `provenance`.

Two things forced this change to the front of the queue:

1. **Reliability**: PGLite's WASM `_pg_initdb` aborts under conditions we can't reliably reproduce locally, and the orchestrator caches the rejected `dbPromise` for the lifetime of the process — so one transient init failure permanently bricks every per-ticket workflow that runs on that worker. Concretely: `persistWorkflowRunStart` is activity 2 of `PerTicketWorkflow`, so workflows never reach `launchWorkerContainer`, no container spawns, and `data/logs/<attemptId>/` stays empty — operators see "running" workflows producing no logs.
2. **Value**: nothing downstream actually reads the rows. Temporal's workflow history, search attributes, and queries already cover "what is this workflow doing right now?", "did this attempt pass?", and "what's the run status?". The `tickets` row is a shadow of Linear; `reviews` and `provenance` are unused stubs reserved for capabilities not yet built.

Constraints:
- No active downstream consumer of the SQL data — verified by grepping `db.query`/`getOrchestratorDb` callers.
- Future capabilities (`review-agent`, `vote-aggregator`, `provenance-store`) will need persistence, but with different shapes (relational vs. content-addressed). They should pick their own store on their own change, not inherit this one.
- We do not want to switch to a real Postgres in this change. That's a strictly larger blast radius (compose service, connection pooling, migrations strategy, prod rollout) and the proposal here is "delete," not "migrate."
- Roadmap Phase 7 already identifies this work as `pglite-drop`.

## Goals / Non-Goals

**Goals:**

- Remove every code path that constructs or queries PGLite from the orchestrator.
- Remove the corresponding requirements from the spec set so the spec/code/test triad stays coherent.
- Replace the only operator-facing affordance the DB provided ("inspect attempt outcomes") with the Temporal-native equivalent already available (workflow describe / search attributes), and document that swap.
- Land the change so a fresh `npm install && npm run --prefix server temporal:worker` boots without ever touching `data/pglite/`.

**Non-Goals:**

- Stand up a Postgres replacement. That belongs to whichever future capability first needs durable relational storage.
- Touch the `server/src/index.ts` Express server beyond removing DB wiring. The separate `server-unused` roadmap item decides whether to delete the dev server entirely.
- Add a new persistence abstraction "for later." If later needs storage, later picks the store.
- Migrate any existing local `data/pglite/pgdata/` rows. Local dev state is disposable; we are not exporting it.

## Decisions

### Decision: Delete the capability outright instead of stubbing the activities

We considered keeping `persistWorkflowRunStart` / `recordAttempt` as no-op activities that log and return, so `PerTicketWorkflow` doesn't change shape. Rejected: a no-op activity that exists only to be ignored is exactly the kind of dead seam that rots and confuses readers. The workflow already has structured logs (Temporal history) for every phase boundary; adding a fake activity to preserve old call sites earns nothing.

**Alternative considered**: keep the activities but route them to `console.log`. Rejected because it implies a contract ("we record attempts") that we no longer keep.

### Decision: Use Temporal search attributes for any "did this attempt fail?" query that survives the migration

The one operator workflow we lose is "SQL-query attempts to find stuck/failed runs across many workflows." Temporal already supports this via search attributes and the visibility store. We do not need to add custom search attributes in this change — Temporal's built-in `ExecutionStatus`, `WorkflowType`, and `CloseTime` cover the questions operators have actually asked. If a future capability needs `phase` or `outcome` as a queryable axis, it adds a typed search attribute at that point, scoped to its own change.

**Alternative considered**: add `currentPhase` / `attemptCount` as custom search attributes now, in this change. Rejected as scope creep — the per-ticket workflow already exposes `currentPhase` and `attemptCount` as Temporal *queries*, which is enough for ad-hoc inspection. Promoting them to search attributes is a separate decision driven by real usage.

### Decision: Remove the `data-persistence` capability rather than emptying its spec

OpenSpec deltas support `## REMOVED Requirements`. We will use that on every requirement of `data-persistence/spec.md`. Once archived, the capability has zero requirements and the apply step is expected to delete `openspec/specs/data-persistence/spec.md` (and the now-empty directory) rather than leaving an empty spec file behind. This is consistent with how OpenSpec treats a capability whose final requirement is removed.

### Decision: Drop `@electric-sql/pglite` from `server/package.json`

Once code references are gone, the dependency is dead weight and a substantial install-time cost (it ships a WASM Postgres). We remove it in the same change so `npm install` after this lands actually frees the install time. If a future change brings back a Postgres-shaped store, it will likely be `pg` against a real server, not PGLite — so leaving the dependency "for later" is misleading.

### Decision: Keep `data/.gitkeep` so the directory exists

The container launcher writes per-attempt logs to `data/logs/<attemptId>/`. That directory is unrelated to PGLite and stays. We delete `data/pglite/` and its `.gitkeep`/`.gitignore` rules; we keep `data/` itself with a top-level `.gitkeep` if needed.

### Decision: Strip DB wiring from `server/src/index.ts`, but leave the Express bootstrap

The `/health` endpoint is consumed by docker compose health checks and is also referenced from the runtime-baseline spec. Removing the database lines (`createDatabase`, `db.migrate`, `app.locals.db`) is mechanical. The broader question of "do we even need this Express server?" is delegated to the existing `server-unused` roadmap item.

## Risks / Trade-offs

- **Risk**: an undiscovered consumer of the SQL data exists outside the orchestrator (e.g., a script in `scripts/` or a test fixture). → **Mitigation**: pre-implementation grep for `getOrchestratorDb`, `app.locals.db`, table names (`workflow_runs`, `attempts`, `reviews`, `provenance`, `tickets`); the apply step in `tasks.md` will fail fast if any new caller has appeared since proposal.
- **Risk**: future capabilities (`review-agent`, `vote-aggregator`, `provenance-store`) re-introduce a per-row persistence need and the absence of a DB layer slows them down. → **Mitigation**: that's their cost to bear; this change explicitly refuses to design a generic store ahead of demand. The first such capability decides the shape.
- **Risk**: operators who today inspect runs by reading PGLite lose that affordance. → **Mitigation**: Temporal Web UI at `localhost:8233` already covers the same surface; document the swap in `README.md` (operator-facing line: "workflow run state lives in Temporal, not in `data/pglite/`").
- **Risk**: tests that today assert "this row got written" become test debt or get deleted along with the DB layer. → **Mitigation**: planned. The DB-touching tests (`db.*.test.ts`, `app.dbContext.test.ts`, plus assertions inside `temporal.ticketWorkflows.test.ts` / `container-lifecycle.test.ts`) are deleted in the same change. Any test whose only signal was a SQL row is replaced with a Temporal-history assertion (`workflow.describe` / `WorkflowExecutionStatus`) where the underlying behavior is still in scope.
- **Trade-off**: we lose the queryable "list every failed attempt across all workflows in the last week" affordance. We did not have a real consumer of that query yet, so we accept the loss until one shows up.

## Migration Plan

This is local dev only — there is no production deployment to migrate. The plan is in-process:

1. Stop the orchestrator worker (PID holding `data/pglite/pgdata` open).
2. Apply this change: code deletions, `package.json` update, spec deltas.
3. `rm -rf data/pglite/` once nothing references it.
4. `npm install` to drop `@electric-sql/pglite` from `node_modules`.
5. Restart `npm run --prefix server temporal:worker`. Verify a `linearPollerWorkflow` run completes and that a freshly-enqueued `perTicketWorkflow` reaches `launchWorkerContainer` (the activity that was being blocked by the DB failure).

**Rollback strategy**: if the orchestrator regresses for an unrelated reason, this change is reverted as a single commit. There is no data to restore — local PGLite state is disposable by definition. If a follow-up change needs persistence, it stands up Postgres on its own terms; it does not bring PGLite back.

## Open Questions

- Should we delete `server/src/index.ts` and the dev server in this same change? — Decided: no. That's the `server-unused` roadmap item; bundling them risks scope drift. This change strips DB wiring from the file and stops there.
- Do we add a `currentPhase`/`outcome` Temporal search attribute now, to soften the loss of SQL queryability? — Decided: no. Search attributes have governance overhead (registration, indexing) and we have no current consumer asking for cross-workflow queries on those axes. Defer to first real ask.
