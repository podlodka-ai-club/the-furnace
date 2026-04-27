## Context

Concept §3.3 ("Container-as-worker, not a long-lived worker pool") and §3.6 ("Ephemeral per attempt, not per ticket") are the load-bearing claims this change implements. Worker lifecycle equals sandbox lifecycle equals one attempt: a container boots, registers as a Temporal worker, claims exactly one task, runs it, dies. No long-lived pool, no state across attempts.

The previous change (`devcontainer-images`) produced digest-pinned per-repo environment images with **no furnace runtime baked in** and **no furnace-specific `CMD`** (see archived spec `devcontainer-image-build/spec.md`, "Producer contract is image plus manifest; worker launch is out of scope"). That change explicitly handed launch, mounts, env, and CMD to this change.

The current orchestration substrate (`server/src/temporal/worker.ts`) runs a single long-lived worker on one task queue (`the-furnace`) that hosts every activity — phase activities, Linear sync, workflow-run persistence. The per-ticket workflow (`server/src/temporal/workflows/per-ticket.ts`) calls phase activities via a single `proxyActivities` block with no task-queue override. That model is incompatible with §3.3: phase activities cannot run inside an ephemeral per-repo container while the workflow still proxies them to the orchestrator's queue.

This change introduces two worker classes (long-lived orchestrator vs. ephemeral container), per-repo task queue routing for phase activities, an orchestrator-side activity that launches containers, and a single-task worker lifetime contract.

## Goals / Non-Goals

**Goals:**
- A container worker entrypoint (`server/src/worker-entry.ts`) that reads capability env vars, joins the matching per-repo task queue, executes exactly one activity, and exits 0.
- A workflow-side dispatch helper (`server/src/temporal/dispatch.ts`) that routes phase activities to the per-repo task queue derived from the ticket's target repo.
- An orchestrator-side activity that launches the container (digest-pinned image from the repo's manifest, `~/.claude` read-only, capability env vars, bind-mounted worker bundle) before each phase task is scheduled.
- Graceful SIGTERM handling: in-flight activity is cancelled cleanly, Temporal retries on a fresh container.
- An integration test that exercises the full lifecycle against a local Temporal — without requiring real Docker — by running the worker entrypoint as a child process.

**Non-Goals:**
- Replacing the agent activity bodies: phase activities remain no-ops here. `spec-agent` / `coder-agent` / `review-agent` own real implementations.
- Multi-repo workflows: each ticket targets exactly one repo.
- Image pull caching strategies, registry retries, or container resource limits — out of scope until production hardening.
- A separate provisioner service or queue-watcher: the workflow itself launches containers via an activity. No detached daemon.
- Runtime devcontainer lifecycle commands (`postCreateCommand`, etc.) — the `devcontainer-images` design left this for future work; this change does not introduce a `devcontainer up` runtime.
- Dynamic capability-based routing (languages, tools): for MVP, the per-repo queue *is* the routing primitive. `WORKER_LANGUAGES` / `WORKER_TOOLS` are recorded for observability only.
- Multi-attempt orchestration logic: Temporal's built-in activity retry plus the ephemerality contract is sufficient. No custom attempt counter beyond what `per-ticket.ts` already exposes.

## Decisions

### 1) Two worker classes: long-lived orchestrator + ephemeral per-repo container

**Decision:** The system runs two distinct Temporal worker shapes:

- **Orchestrator worker** (long-lived): the existing `server/src/temporal/worker.ts` process. Hosts workflows (`linear-poller`, `per-ticket`, `hello`), the Linear activities, the workflow-run persistence activities, and the new `launchWorkerContainer` activity. Listens on the existing `the-furnace` queue (renamed conceptually to "orchestrator" in code comments; env var stays `TEMPORAL_TASK_QUEUE`). One process per orchestrator deployment.
- **Container worker** (ephemeral): the new `server/src/worker-entry.ts` process. Hosts only the phase activities (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`). Listens on a per-repo queue `repo-${REPO_SLUG}-worker`. Exits after exactly one activity completes (success, failure, or cancellation). One process per attempt.

The two share the same source tree and the same activity implementations, but register different subsets at startup.

**Rationale:** Splitting cleanly along the queue boundary lets Temporal — not the application — route work. The orchestrator's activities (Linear API calls, DB writes) need persistent connections and should not pay container-boot cost per call. The container's activities (running tests inside the repo) need the repo environment and must die per attempt to honor §3.6. Mixing them on one queue would force every activity into one execution context.

**Alternatives considered:**
- **One worker process with capability tags filtering tasks:** Temporal does not expose tag-based task filtering on a single queue; queues *are* the routing primitive. Rejected.
- **Run the orchestrator inside the container too:** would require the orchestrator's DB and Linear credentials inside every container. Inverts the trust boundary. Rejected.
- **Have the workflow itself run inside the container:** workflows must be deterministic and replay-safe. Pinning workflows to ephemeral workers makes replay impossible across attempts. Rejected.

### 2) Per-repo task queue is the only routing primitive; capability env vars are observational

**Decision:** Each container joins exactly one Temporal task queue named `repo-${REPO_SLUG}-worker`, where `REPO_SLUG` matches the slug from `build/repos.json`. The slug is the contract field shared with `devcontainer-image-build`.

`WORKER_REPO` (the slug) is the *only* env var that affects routing. `WORKER_LANGUAGES` and `WORKER_TOOLS` are recorded by `worker-entry.ts` in a startup log line and exposed via a `workerInfoQuery` on the workflow if needed later, but they do not influence which tasks the worker claims.

The workflow-side dispatch helper (`server/src/temporal/dispatch.ts`) exposes `phaseActivitiesForRepo(repoSlug, options)` that returns a `proxyActivities`-style object whose calls go to `repo-${repoSlug}-worker`. The per-ticket workflow looks up the repo slug from the ticket (see Decision 7) and calls phase activities through this helper.

**Rationale:** Task queues are the only mechanism Temporal offers for routing decisions made by the workflow at call time. Tying the queue name to the slug — already validated and uniqueness-checked by `devcontainer-images` — reuses an existing identity primitive instead of inventing a new one. Capability metadata beyond the slug is interesting for future routing (e.g., picking among workers when there are multiple per repo) but adds nothing for MVP, where one container exists per attempt and is dedicated to one repo.

**Alternatives considered:**
- **Capability matchmaking via custom search attributes:** would require a separate dispatch service to do matchmaking and re-emit tasks onto worker-specific queues. Heavyweight for MVP. Rejected.
- **One queue per (repo × language × tool) cross-product:** combinatorial explosion. Rejected.
- **One queue per attempt UUID:** workflow would have to wait for the worker to register before scheduling, creating a chicken-and-egg ordering. Rejected.

### 3) Single-task lifetime: wrap activities; shut worker down after the first activity completes or cancels

**Decision:** `worker-entry.ts` builds the activity registry by wrapping each phase activity in a "shutdown after this returns" decorator. The wrapper:

1. Runs the underlying activity to completion (success, throw, or cancel).
2. After the result settles, schedules a `worker.shutdown()` call on the next tick.
3. Returns/rethrows the result so Temporal sees the original outcome.

The worker is created with `maxConcurrentActivityTaskExecutions: 1` so it cannot pick up a second task while shutting down. After `worker.shutdown()` resolves, the process exits 0 (or non-zero if the activity threw).

**Rationale:** `Worker.runUntil()` already supports a "run until predicate" pattern, but predicates are inspected before each task pickup, not after task completion — there is no built-in "exit after one task" knob. Wrapping the activity is the simplest place to insert the lifetime hook because the wrapper sees the moment the activity returns, before the worker becomes available to claim another task. With `maxConcurrentActivityTaskExecutions = 1`, no second task can interleave during the shutdown window.

**Alternatives considered:**
- **Have the activity itself call `process.exit(0)` after returning:** Temporal needs to ship the activity result to the server before shutdown; calling `process.exit` from inside the activity drops the result. Rejected.
- **A separate sidecar that watches Temporal for the activity to complete then kills the container:** correct but introduces a new daemon and a coordination contract. Rejected.
- **Configure the worker with `taskQueueActivitiesPerSecond: 1` and a hard `runUntil` deadline:** adds time-based assumptions and doesn't actually guarantee one task. Rejected.

### 4) Container launch is an orchestrator-side activity, scheduled before each phase

**Decision:** Add `launchWorkerContainer({ ticket, phase, attempt }): Promise<{ containerId, queue }>` to the orchestrator's activities. Implementation runs `docker run --rm -d` with:

- **Image:** `imageRef` from `build/<slug>/manifest.json` (digest-pinned).
- **Command:** the worker bundle's entry, invoked as `node /opt/furnace/worker-entry.js`. The bundle is bind-mounted, not baked (Decision 5 explains why).
- **Env:**
  - `WORKER_REPO=${slug}`
  - `WORKER_LANGUAGES`, `WORKER_TOOLS` from `build/repos.json` (informational)
  - `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` from orchestrator env
  - `WORKER_ATTEMPT_ID` for log correlation
- **Mounts:**
  - `~/.claude` host → `/root/.claude` read-only (Claude SDK subscription auth, per concept §2)
  - the orchestrator's prebuilt worker bundle directory → `/opt/furnace` read-only
- **No publish ports.** Workers initiate outbound Temporal connections; nothing inbound is needed.

The per-ticket workflow calls `launchWorkerContainer` for each phase before calling the phase activity itself. The launch activity returns once `docker run -d` exits with a container ID — it does not wait for the worker to register. If the activity returns successfully but no worker registers within the phase's `scheduleToStartTimeout`, Temporal retries the phase, which retries `launchWorkerContainer` (a fresh container is launched).

**Rationale:** Inlining launch as a workflow step keeps the relationship between attempts and containers expressible in workflow history. Temporal can replay it, retry it, and surface it in the UI without a separate provisioner service. The decision to *not* await registration keeps the activity short and keeps the launch contract symmetric with how Temporal already handles "scheduled but not yet claimed" tasks.

The image is digest-pinned at the manifest level, the bundle is mounted from the orchestrator's filesystem (which is also pinned by deployment), and `~/.claude` is the only host-shared resource — exactly the surface the concept §2 describes.

**Alternatives considered:**
- **Bake the worker bundle into the image:** breaks the `devcontainer-image-build` producer contract ("the image carries no the-furnace runtime code"), and would require rebuilding every per-repo image whenever the worker bundle changes. Rejected.
- **Use `devcontainer up` instead of `docker run`:** richer lifecycle (mounts, env from devcontainer.json), but would require deciding how to layer worker invocation into the devcontainer model. Tractable later, but for MVP the explicit `docker run` contract is small and well-defined. Deferred.
- **Pre-launch a pool of warm containers per repo:** contradicts §3.3 (long-lived worker pool is exactly what we're rejecting). Rejected.
- **Have a separate provisioner service watch a "launch" task queue:** adds an out-of-band component and a separate failure surface for an MVP that does not need it. Rejected.

### 5) Worker bundle is shipped via bind-mount, not bundled into the image

**Decision:** Add a `npm run build:worker` script (or equivalent) that produces `dist/worker/` containing `worker-entry.js` plus its runtime dependencies (Node `node_modules` resolved for the worker subset). The orchestrator deploys this directory and bind-mounts it into every spawned container at `/opt/furnace` (read-only).

The container's CMD override is `node /opt/furnace/worker-entry.js`. The container's image does not contain any furnace code, exactly as the previous change requires.

**Rationale:** Decouples the worker runtime from the per-repo environment images. A change to `worker-entry.ts` or its dependencies redeploys the orchestrator and takes effect on the next attempt's launch — no per-repo image rebuild needed. Pinning at the orchestrator level (one bundle for the whole deployment) is the right granularity because the worker code is generic across repos.

The bind-mount carries trust (it executes as the container's main process), but the orchestrator already has full launch authority — there is no privilege escalation introduced.

The container needs Node.js to run the worker. Devcontainer base images for our demo repos (Node-flavored) already have it. Repos whose `devcontainer.json` does not include Node would need to gain it via a future capability hook; out of MVP scope.

**Alternatives considered:**
- **Ship a single self-contained binary (e.g., via `pkg` or `bun build`) and mount only that:** removes the Node-on-image assumption but adds a build-pipeline dependency and complicates Temporal SDK loading. Defer to V1+.
- **Push the bundle to a registry and `docker pull` it as a sidecar:** more moving parts. Rejected.
- **Run the worker on the orchestrator host and only run agent commands inside the container:** that *is* concept §5's "Split reasoning from execution" — it's V1+ work, explicitly out of scope here.

### 6) Graceful SIGTERM: shut the worker down, let Temporal retry on a fresh container

**Decision:** `worker-entry.ts` registers SIGTERM and SIGINT handlers that call `worker.shutdown()`. Phase activities are written to call `Context.heartbeat(progress)` periodically; this is what propagates cancellation from `worker.shutdown()` into the activity body. On cancellation, the activity throws `CancelledFailure`, which Temporal records and reschedules per the activity's retry policy.

Activities have a `heartbeatTimeout` configured (e.g., 30s) to detect dead workers and a retry policy with `maximumAttempts` bounded so a chronically failing activity surfaces to the workflow rather than retrying forever.

The container's `--rm` flag ensures Docker reaps the container after the process exits, keeping the host clean.

**Rationale:** Concept §3.6 says cleanup is a free side-effect of completion. SIGTERM during a real shutdown (orchestrator deploy, host eviction) is just another path to the same end state: the worker dies, Temporal sees the activity uncomplete, a fresh container is launched on retry. No state to clean up because the container is `--rm` and the worker holds nothing on disk.

**Alternatives considered:**
- **Force-kill on SIGTERM and let Temporal recover via heartbeat timeout:** simpler code but adds a 30-second silent-failure window. Cooperative shutdown is cheap; we should use it.
- **Persist activity progress and resume in-place after restart:** would re-introduce per-attempt state. Rejected.

### 7) Ticket → repo slug mapping is required input to the workflow

**Decision:** Extend `PerTicketWorkflowInput` with `targetRepoSlug: string`. The Linear poller's `listAgentReadyTicketsActivity` resolves the slug from a Linear ticket field (e.g., custom field, label, or project mapping — the precise resolution is out of scope here, but the activity contract changes to include the slug). The workflow uses the slug to derive `repo-${slug}-worker` for phase dispatch.

If `targetRepoSlug` is missing or does not match a known entry in `build/repos.json`, the workflow fails fast in `runSpecPhase` setup with an actionable error before launching any container.

**Rationale:** The workflow needs *some* way to know which repo a ticket is about. Embedding the slug in workflow input keeps the per-ticket workflow self-contained and replay-safe (the slug is part of the workflow's history, not re-resolved on replay). Reading from a separate activity per phase would add round-trips and risk per-phase divergence.

This change does not commit to *how* the slug is derived from a Linear ticket — that's `linear-integration` territory. It does commit to the slug being present at workflow start.

**Alternatives considered:**
- **Read the slug from a workflow query in the launch activity:** unnecessary indirection. Rejected.
- **Hardcode a single-repo slug for MVP:** too brittle as soon as a second demo repo ships. Rejected.

### 8) Integration tests run the worker as a Node child process; Docker is not exercised

**Decision:** `server/tests/integration/container-lifecycle.test.ts` exercises the lifecycle without a real container by:

1. Starting the orchestrator worker against a local Temporal (matching the existing pattern in `temporal.helloWorkflow.test.ts`).
2. Spawning `worker-entry.ts` as a Node child process with stub env vars (`WORKER_REPO=test-repo`).
3. Stubbing the `launchWorkerContainer` activity to spawn the same child process instead of running `docker run`, so the workflow path is exercised end-to-end on the orchestrator side.
4. Verifying:
   - The child process exits 0 after one activity completes.
   - SIGTERM during an activity → activity reports `CancelledFailure` → child exits → orchestrator schedules a retry → the new (re-spawned) child completes the activity.
   - Phase activity is dispatched on `repo-test-repo-worker`, not the orchestrator queue.

A separate Docker-backed E2E (similar in spirit to `npm run test:devcontainer:e2e`) is added under `npm run test:container-as-worker:e2e` for manual / CI pre-merge runs but is not part of `npm test`.

**Rationale:** The "lifecycle works" claim is about Temporal's worker shape and the orchestrator's launch contract — both expressible without Docker. Pulling the demo image, mounting `~/.claude`, and shelling to `docker run` are validated by the manual E2E and by the existing `test:devcontainer:e2e` for the image side. Splitting fast unit-grade lifecycle tests from a heavier Docker E2E keeps `npm test` runnable without registry credentials.

**Alternatives considered:**
- **Require a real Docker daemon for `npm test`:** raises the bar for contributors; the existing test suite already pays this cost only in the devcontainer E2E. Rejected for parity.
- **Mock Temporal entirely:** loses the integration claim. Rejected.

## Risks / Trade-offs

- **[Risk] The container's image lacks Node.js, so `node /opt/furnace/worker-entry.js` fails on boot** → Mitigation: curated demo repos for MVP have Node-flavored devcontainer bases (the seeded `microsoft/vscode-remote-try-node` does). Adding a non-Node repo requires either (a) ensuring its devcontainer base includes Node, (b) shipping a self-contained worker binary (Decision 5 alternative), or (c) deferring that repo. Documented as a curation criterion.

- **[Risk] Bind-mounted `~/.claude` leaks credentials if a container is compromised** → Mitigation: read-only mount, `--rm` removes the container, agent is running code we trust enough to merge. Concept §2 already accepts this trust posture for MVP. Defense-in-depth (per-attempt scoped tokens) is V1+.

- **[Risk] `worker.shutdown()` races with the activity completing — a second task is claimed before shutdown takes effect** → Mitigation: `maxConcurrentActivityTaskExecutions = 1` ensures the worker is fully busy with the one task; shutdown is initiated synchronously after the activity returns and before the worker becomes free. Verified by integration test.

- **[Risk] Docker daemon unavailable on the orchestrator → `launchWorkerContainer` fails for every ticket** → Mitigation: the activity fails loudly with the docker error in the workflow history. The retry policy bounds the blast radius. A long-running Docker outage will surface to operators via Temporal UI immediately.

- **[Risk] Per-repo task queue starvation if no container is launched** → Mitigation: `scheduleToStartTimeout` on the phase activity caps how long a task can sit unclaimed. Hitting the timeout retries the phase, which retries the launch activity. Operationally, an unclaimed task signals a launch failure that should already have surfaced through `launchWorkerContainer`.

- **[Risk] Bind-mounting the worker bundle from the orchestrator host requires Docker-on-the-orchestrator and shared filesystem semantics** → Mitigation: acceptable for MVP single-host deployment. A multi-host or container-orchestrated deployment (K8s, ECS) would replace bind-mounts with sidecar/init-container patterns; that's a deployment-shape concern handled when we leave single-host MVP.

- **[Trade-off] Two worker processes to operate, two queues to monitor** → Acceptable. Temporal UI surfaces both naturally. The split is intrinsic to the §3.3 claim.

- **[Trade-off] Worker bundle changes redeploy the orchestrator, but per-repo image changes do not require a worker redeploy** → Acceptable and intentional. Decoupling worker runtime from per-repo environment is the point.

- **[Trade-off] Capability env vars (`LANGUAGES`/`TOOLS`) are observational only in MVP** → Acceptable. The §3.3 claim is about lifecycle, not about capability matchmaking. Real matchmaking lands when a second worker shape per repo exists.

## Migration Plan

1. Add `server/src/worker-entry.ts` with: env var parsing (`WORKER_REPO` required; `WORKER_LANGUAGES`/`WORKER_TOOLS` optional), Temporal connection, phase activities registered with the single-task wrapper (Decision 3), SIGTERM/SIGINT handlers, exit-code propagation.
2. Add `server/src/temporal/dispatch.ts` exposing `phaseActivitiesForRepo(slug, options)` that returns `proxyActivities`-shaped phase functions bound to `repo-${slug}-worker`.
3. Update `server/src/temporal/worker.ts` to register `launchWorkerContainerActivity` and to make clear (via comment / type) that phase activities are *not* registered on the orchestrator queue in production. (For backwards compatibility with existing tests, allow tests to inject phase activities, as `temporal.ticketWorkflows.test.ts` already does.)
4. Update `server/src/temporal/activities/phases.ts` to call `Context.heartbeat()` periodically inside each phase (still no-op bodies) so cancellation propagates.
5. Update `PerTicketWorkflowInput` to include `targetRepoSlug`. Update `linear-poller`'s `startChild` call site to pass it through. Update existing tests to provide it.
6. Replace the per-ticket workflow's single `proxyActivities` for phases with `phaseActivitiesForRepo(input.targetRepoSlug, ...)`. Surround each phase call with a prior `launchWorkerContainer` call.
7. Add `server/src/worker-launcher.ts` (used by `launchWorkerContainerActivity`) that runs `docker run --rm -d` with the env, mounts, and image from `build/<slug>/manifest.json`.
8. Add `npm run build:worker` that produces the bundle deployed alongside the orchestrator.
9. Add `server/tests/integration/container-lifecycle.test.ts` per Decision 8.
10. Add `npm run test:container-as-worker:e2e` for the Docker-backed end-to-end (manual / pre-merge), modeled on `scripts/test-devcontainer-image-e2e.ts`.
11. Update `openspec/specs/orchestration-substrate/spec.md` to reflect that task-queue routing is per-repo for phase activities (the proposal lists this as a modified capability).
12. Add `openspec/specs/container-worker-lifecycle/spec.md` covering: capability env vars, single-task lifetime, SIGTERM handling, mount contract, queue naming, integration with `launchWorkerContainer`.

**Rollback strategy:** revert the per-ticket workflow's phase calls to use the orchestrator queue's `proxyActivities` and remove the launch activity. Phase activities remain no-ops, so the orchestrator-only path still completes a workflow end-to-end. The new files (`worker-entry.ts`, `dispatch.ts`, `worker-launcher.ts`) are unreferenced by anything else and can be deleted.

## Open Questions

- Where in a Linear ticket does `targetRepoSlug` live — a custom field, a label prefix, or the project? Owned by `linear-integration`. For this change, we assume the slug is *somehow* present in the ticket payload by the time the per-ticket workflow starts.
- Is `node /opt/furnace/worker-entry.js` the right CMD shape for non-Node devcontainer bases (Python, Go)? MVP demo repo is Node, so this is deferred until a non-Node repo is curated. A self-contained binary is the most likely answer.
- Should `launchWorkerContainer` also include a `WORKER_BUNDLE_VERSION` env var so a future "wrong-bundle" check inside `worker-entry.ts` can fail fast? Cheap to add later; deferred.
- Heartbeat cadence: 5s? 10s? Activity-by-activity? Pinned at design-implementation handoff once phase activity bodies become real.
- For the integration test's "spawn child process" approach, do we want a separate `npm` script entry to make the child process easy to launch, or is `tsx` directly fine? Implementation detail; decided in tasks.
