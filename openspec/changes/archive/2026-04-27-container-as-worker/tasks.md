## 1. Shared types and helpers

- [x] 1.1 Add a `RepoSlug` branded type (or shared validator) in `server/src/temporal/repo-slug.ts` that resolves a slug against `build/repos.json` and throws with the slug name on miss
- [x] 1.2 Add a small env-parser helper in `server/src/worker-env.ts` exposing `readContainerWorkerEnv()` that returns `{ repo, languages, tools, attemptId, temporal }` and throws (naming the missing var) when `WORKER_REPO`, `TEMPORAL_ADDRESS`, or `TEMPORAL_NAMESPACE` is unset
- [x] 1.3 Export a `taskQueueForRepo(slug: string): string` helper that returns `repo-${slug}-worker`, used by both the workflow dispatcher and the launch activity so the queue-name contract has one source of truth

## 2. Container worker entrypoint

- [x] 2.1 Create `server/src/worker-entry.ts` that calls `readContainerWorkerEnv()`, logs a single startup line containing slug/languages/tools, and exits non-zero before any Temporal connect when required env is missing
- [x] 2.2 Connect to Temporal using `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` and create a `Worker` bound to `taskQueueForRepo(repo)` with `maxConcurrentActivityTaskExecutions: 1`
- [x] 2.3 Implement a `singleTaskActivity(impl)` wrapper that runs the underlying activity, schedules `worker.shutdown()` on the next tick after the result settles, and rethrows/returns the original outcome
- [x] 2.4 Register only the phase activities (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`) wrapped with `singleTaskActivity`; do not register workflows or orchestrator-only activities
- [x] 2.5 Install SIGTERM and SIGINT handlers that call `worker.shutdown()`, and propagate the activity's eventual outcome into the process exit code (0 on success, non-zero on uncaught failure)
- [x] 2.6 Fail fast (non-zero exit) if the Temporal connection cannot be established, with an error message that names the unreachable endpoint

## 3. Worker bundle build

- [x] 3.1 Add `npm run build:worker` (using `tsc` or the project's existing bundler) that emits `dist/worker/worker-entry.js` plus a resolved `node_modules` subset sufficient to run the entrypoint
- [x] 3.2 Document in the orchestrator deployment notes (or a code comment near the build script) that the produced directory is the bind-mount source for `/opt/furnace`
- [x] 3.3 Ensure the build excludes orchestrator-only code paths (workflows, Linear client, DB layer) so the bundle stays small and the trust surface is minimal

## 4. Workflow-side dispatch helper

- [x] 4.1 Create `server/src/temporal/dispatch.ts` exporting `phaseActivitiesForRepo(slug, options)` that returns a `proxyActivities`-shaped object (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`) with `taskQueue: taskQueueForRepo(slug)` and the configured `scheduleToStartTimeout` / `heartbeatTimeout` / retry policy
- [x] 4.2 Define and export the activity-options defaults used for phase dispatch (heartbeat timeout, retry policy with bounded `maximumAttempts`, schedule-to-start timeout) so they live in one place

## 5. Container launch activity

- [x] 5.1 Add `server/src/worker-launcher.ts` exposing `launchWorkerContainer({ ticket, phase, attemptId, repoSlug })` that resolves `imageRef` from `build/<slug>/manifest.json`, runs `docker run --rm -d` with the documented env (`WORKER_REPO`, `WORKER_LANGUAGES`, `WORKER_TOOLS`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_ATTEMPT_ID`) and mounts (`~/.claude` → `/root/.claude` ro, worker-bundle dir → `/opt/furnace` ro), no published ports, CMD `node /opt/furnace/worker-entry.js`
- [x] 5.2 Have the launcher return `{ containerId, queue }` once `docker run -d` exits, without awaiting worker registration; surface Docker stderr in the thrown error on failure
- [x] 5.3 Register `launchWorkerContainer` as an activity on the orchestrator worker (`server/src/temporal/worker.ts`)
- [x] 5.4 Add a code comment in `worker.ts` clarifying that phase activities are NOT registered on the orchestrator queue in production, and gate any test-only injection behind an explicit options flag

## 6. Workflow integration

- [x] 6.1 Extend `PerTicketWorkflowInput` with a required `targetRepoSlug: string`
- [x] 6.2 Update the Linear poller (`startChild` call site for `per-ticket`) to pass `targetRepoSlug` through from the activity that resolves it (resolution itself is deferred to `linear-integration`; for now, accept it from the ticket payload or input)
- [x] 6.3 In the per-ticket workflow, validate `targetRepoSlug` against the known set at the start of spec-phase setup and fail fast with an actionable error before any container launch
- [x] 6.4 Replace the workflow's single `proxyActivities` for phase activities with a call to `phaseActivitiesForRepo(input.targetRepoSlug, ...)`
- [x] 6.5 Wrap each phase activity invocation with a preceding `launchWorkerContainer` call (one launch per phase invocation, including retries, so that Temporal-driven retries always run on a fresh container)
- [x] 6.6 Update existing per-ticket workflow tests to provide `targetRepoSlug` in their input fixtures

## 7. Phase activity heartbeats

- [x] 7.1 Update `server/src/temporal/activities/phases.ts` so each no-op phase activity calls `Context.heartbeat()` on a periodic interval that fits within the configured `heartbeatTimeout`
- [x] 7.2 Ensure heartbeats propagate cancellation: when `worker.shutdown()` is initiated the activity body observes `Context.cancellationSignal()` and throws `CancelledFailure`

## 8. Integration tests (no Docker)

- [x] 8.1 Add `server/tests/integration/container-lifecycle.test.ts` that boots the orchestrator worker against a local Temporal (mirroring `temporal.helloWorkflow.test.ts`)
- [x] 8.2 Stub `launchWorkerContainer` in the test to spawn `worker-entry.ts` as a `tsx` (or compiled) child process with `WORKER_REPO=test-repo` instead of running `docker run`
- [x] 8.3 Verify the child process exits 0 after exactly one phase activity completes
- [x] 8.4 Verify SIGTERM during an in-flight activity → `CancelledFailure` recorded → child exits → orchestrator schedules a retry → the next stub-launched child completes the activity
- [x] 8.5 Assert phase activities were dispatched on `repo-test-repo-worker`, not the orchestrator queue
- [x] 8.6 Assert the workflow fails fast when `targetRepoSlug` is missing or unknown, before any launch occurs

## 9. Docker E2E (manual / pre-merge)

- [x] 9.1 Add `server/scripts/test-container-as-worker-e2e.ts` that builds the demo per-repo image (or reuses an existing built image), produces the worker bundle, runs `launchWorkerContainer` against the real Docker daemon, and asserts the container exits 0 after one phase activity
- [x] 9.2 Wire the script up as `npm run test:container-as-worker:e2e` and document that it is not part of `npm test`

## 10. Verification

- [x] 10.1 Run `npm test` and confirm all integration tests pass, including the new `container-lifecycle` suite
- [x] 10.2 Run `npm run test:container-as-worker:e2e` against a local Docker daemon and a built demo image, confirming the full lifecycle (launch → claim → execute → exit) works end-to-end
- [x] 10.3 Run `openspec validate container-as-worker --strict` and confirm no diagnostics
