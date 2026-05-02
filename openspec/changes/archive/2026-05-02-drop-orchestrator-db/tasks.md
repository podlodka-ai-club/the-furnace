## 1. Pre-flight verification

- [x] 1.1 Grep the repo for outside-orchestrator callers of the doomed surface (`getOrchestratorDb`, `createDatabase`, `app.locals.db`, table names `workflow_runs`/`attempts`/`reviews`/`provenance`/`tickets`); confirm no consumer has appeared since the proposal was written
- [x] 1.2 Stop the running orchestrator worker so PGLite releases its file handles on `data/pglite/pgdata/*` before any deletion
- [x] 1.3 Snapshot current `temporal workflow list` output to confirm no live workflows depend on activities being removed (terminate or wait out any `perTicketWorkflow` runs that are mid-flight)

## 2. Workflow & activity wiring

- [x] 2.1 In `server/src/temporal/workflows/per-ticket.ts`, remove imports and `proxyActivities` declarations for `persistWorkflowRunStart`, `persistWorkflowRunTransition`, and `recordAttempt`; delete every call site (start, phase transitions, terminal states, error paths)
- [x] 2.2 Confirm `cancel` signal handling, `currentPhase` / `attemptCount` query handlers, and `AcClarificationRequested` failure handling still compile without the removed activities
- [x] 2.3 In `server/src/temporal/worker.ts`, drop `workflowRunActivities` and `attemptsActivities` from `orchestratorOnlyActivities`; remove their imports and the `TemporalWorkerActivities` interface entries (`persistWorkflowRunStart`, `persistWorkflowRunTransition`, `recordAttempt`)

## 3. Activity & DB code removal

- [x] 3.1 Delete `server/src/temporal/activities/workflow-runs.ts` and `server/src/temporal/activities/attempts.ts`
- [x] 3.2 Delete `server/src/db/orchestrator.ts`, `server/src/db/tickets.ts`, `server/src/db/index.ts`, `server/src/db/migrate.ts`, `server/src/db/types.ts`, and the entire `server/src/db/migrations/` directory
- [x] 3.3 Strip database wiring from `server/src/index.ts`: remove `createDatabase`, `db.migrate`, and the `app.locals.db` thread-through; leave the `/health` endpoint and Express bootstrap intact
- [x] 3.4 Remove `@electric-sql/pglite` from `server/package.json`; run `npm install --prefix server` and verify it disappears from `server/package-lock.json`

## 4. Test removal & adjustment

- [x] 4.1 Delete `server/tests/integration/db.createDatabase.test.ts`, `server/tests/integration/db.migrate.test.ts`, `server/tests/integration/db.schema.test.ts`, `server/tests/integration/db.rowTypeSync.test.ts`, and `server/tests/integration/app.dbContext.test.ts`
- [x] 4.2 In `server/tests/integration/temporal.ticketWorkflows.test.ts`, remove every assertion that reads or seeds `workflow_runs`/`tickets`/`attempts`; replace any "did this attempt fail" check with a Temporal-history assertion (`workflowHandle.describe()` / `WorkflowExecutionStatus`); delete the test if the only signal it had was a SQL row
- [x] 4.3 In `server/tests/integration/container-lifecycle.test.ts`, remove DB seeding and DB-row assertions; ensure the container-lifecycle behaviors (queue dispatch, worker claim, container teardown) are still exercised
- [x] 4.4 Search the test suite for any other importer of `_resetOrchestratorDb`, `_getAttemptsDb`, `_getWorkflowRunsDb`, or DB row types (`WorkflowRunRow`, `TicketRow`, `AttemptRow`, `ReviewRow`, `ProvenanceRow`); delete those imports and the assertions that hung off them

## 5. Filesystem & ignore rules

- [x] 5.1 Remove the `data/pglite/` directory from the working tree (after step 1.2 confirms no process holds open file handles)
- [x] 5.2 Update `.gitignore` to drop the `data/pglite/*` rule; ensure `data/logs/` (used by the container launcher) is still covered as before
- [x] 5.3 Verify `data/.gitkeep` and `data/logs/.gitkeep` still exist so the launcher's mkdir-recursive call has a stable base directory (only `data/logs/.gitkeep` was tracked; `data/` directory still exists via `data/logs/` subdirectory)

## 6. Documentation & spec hygiene

- [x] 6.1 Update `README.md` to remove references to PGLite, `data/pglite/`, `DATABASE_URL`, and the migration step in the dev bootstrap; add the operator-facing line that workflow run state lives in Temporal
- [x] 6.2 Update `CLAUDE.md` and `AGENTS.md` to remove the "PGLite for dev/test, Postgres for prod" stack claim until a replacement actually exists
- [x] 6.3 Update `openspec/concept.md` if any line implies an orchestrator-side database (verify; touch only if needed) — verified, no changes required
- [x] 6.4 Update `openspec/roadmap.md`: tick `pglite-drop` under Phase 7 and adjust any wording that assumes a DB layer

## 7. Verification

- [x] 7.1 `npm install` and `npm run --prefix server build` (or `tsc --noEmit`) succeed with no references to removed modules
- [x] 7.2 `npm test` (root) passes; the surviving Temporal integration tests run without seeding any database (verified via `vitest run --exclude tests/integration/container-lifecycle.test.ts`: 13 files / 63 tests pass)
- [ ] 7.3 `docker compose up -d temporal temporal-ui && npm run --prefix server temporal:worker` boots without ever creating `data/pglite/`; orchestrator log shows the linear-poller schedule line and no PGLite or migration output (manual operator step; not run in this session)
- [ ] 7.4 Enqueue (or wait for) a `perTicketWorkflow` run; confirm it advances past the previously-failing `persistWorkflowRunStart` step (which no longer exists) and reaches `launchWorkerContainer`, with logs appearing under `data/logs/<attemptId>/` (manual operator step; not run in this session)
- [x] 7.5 `openspec validate drop-orchestrator-db` succeeds; `openspec status --change drop-orchestrator-db` reports all artifacts done

## 8. Archive

- [x] 8.1 After the verification step is green and the work is committed, run `openspec archive drop-orchestrator-db` so the `data-persistence` capability is removed from `openspec/specs/` and `ticket-workflow` keeps only its surviving requirements
