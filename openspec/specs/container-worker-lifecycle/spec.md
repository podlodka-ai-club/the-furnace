# container-worker-lifecycle Specification

## Purpose

Define the lifecycle of ephemeral per-attempt Temporal workers that run inside per-repo devcontainers: how they bootstrap from environment metadata, bind to a per-repo task queue, execute exactly one phase activity, propagate cancellation cooperatively, and how the orchestrator launches them via a dedicated activity with bind-mounted worker bundle and host Claude credentials. Together these requirements isolate phase execution into the target repo's toolchain while reusing the operator's Claude subscription and avoiding per-repo image rebuilds for worker code changes.

## Requirements

### Requirement: Container worker entrypoint reads capability metadata from environment

The system SHALL provide `server/src/worker-entry.ts` as the entrypoint executed inside per-repo containers. On startup it MUST read `WORKER_REPO` (required, the repo slug from `build/repos.json`), `WORKER_LANGUAGES`, and `WORKER_TOOLS` from the process environment. `WORKER_REPO` is the only env var that influences task-queue routing; `WORKER_LANGUAGES` and `WORKER_TOOLS` are recorded for observability only.

#### Scenario: Required slug is missing

- **WHEN** the entrypoint starts with `WORKER_REPO` unset
- **THEN** the process exits non-zero with an error message naming the missing variable, before any Temporal connection attempt

#### Scenario: Capability env vars are logged at startup

- **WHEN** the entrypoint starts with `WORKER_REPO=demo`, `WORKER_LANGUAGES=ts,js`, `WORKER_TOOLS=npm,vitest`
- **THEN** a single startup log line records the slug, languages, and tools so that operators can correlate a container with the capabilities it advertised

### Requirement: Container worker joins per-repo Temporal task queue

The system SHALL connect the container worker to Temporal using `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` from the environment, registering only the phase activities (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`) on the task queue named `repo-${WORKER_REPO}-worker`. The worker MUST NOT register workflow modules or orchestrator-only activities (Linear, workflow-run persistence, container launch).

#### Scenario: Worker binds to the per-repo queue derived from the slug

- **WHEN** the entrypoint starts with `WORKER_REPO=demo` against a reachable Temporal frontend
- **THEN** a worker process binds to task queue `repo-demo-worker` and is visible on that queue in the Temporal UI

#### Scenario: Worker fails fast when Temporal is unreachable

- **WHEN** the entrypoint starts while the configured Temporal endpoint is unavailable
- **THEN** the process exits non-zero with an error indicating it could not connect to Temporal, without claiming any task

### Requirement: Container worker has single-task lifetime

The system SHALL ensure each container worker claims and executes exactly one phase activity, then exits. The worker MUST be configured with `maxConcurrentActivityTaskExecutions: 1`, and each phase activity MUST be wrapped so that after the activity result settles (success, failure, or cancellation) the worker is shut down before any second task can be claimed. The process exit code MUST reflect the underlying activity outcome (0 on success, non-zero on uncaught failure during shutdown).

#### Scenario: Worker exits cleanly after one successful activity

- **WHEN** the container worker claims a phase activity and the activity returns successfully
- **THEN** the worker shuts down and the process exits with code 0, having claimed no further tasks

#### Scenario: Worker exits after activity throws

- **WHEN** the container worker claims a phase activity and the activity throws an error
- **THEN** Temporal records the failure, the worker shuts down, and the process exits without claiming a second task

#### Scenario: Concurrency cap prevents claiming a second task during shutdown

- **WHEN** an activity completes and shutdown is in progress
- **THEN** the worker does not pick up another task from the queue, because the activity slot is still held until shutdown resolves

### Requirement: Container worker handles SIGTERM cooperatively

The system SHALL register SIGTERM and SIGINT handlers in the container worker that initiate `worker.shutdown()`. In-flight phase activities MUST be cancelled cooperatively via Temporal's cancellation propagation, which requires phase activities to call `Context.heartbeat()` periodically. After the cancelled activity settles, the worker process MUST exit, leaving the activity recorded as cancelled in Temporal so a fresh container can be launched on retry.

#### Scenario: SIGTERM during activity execution cancels and exits

- **WHEN** the container receives SIGTERM while a phase activity is running
- **THEN** the activity's heartbeat surfaces the cancellation, the activity throws `CancelledFailure`, the worker shuts down, and the process exits — and Temporal records the activity as cancelled, eligible for retry

#### Scenario: Phase activities heartbeat to enable cancellation

- **WHEN** a phase activity executes
- **THEN** it calls `Context.heartbeat()` periodically so that worker shutdown can propagate cancellation into the activity body within the configured `heartbeatTimeout`

### Requirement: Container worker mounts host Claude credentials read-only

The system SHALL launch each container worker with the host's `~/.claude` directory bind-mounted read-only at `/root/.claude`, so Claude SDK calls inside the container reuse the operator's subscription auth without copying credentials onto disk inside the container. No other host paths are mounted apart from the worker bundle (see worker bundle requirement).

#### Scenario: Claude credentials directory is available read-only

- **WHEN** a container worker is launched
- **THEN** `/root/.claude` exists inside the container, is backed by the host's `~/.claude`, and is read-only

#### Scenario: No additional host filesystem leaks into the container

- **WHEN** a container worker is launched
- **THEN** the container has no other host bind-mounts beyond `~/.claude` (read-only) and the orchestrator's worker bundle directory (read-only)

### Requirement: Worker bundle is bind-mounted, not baked into the image

The system SHALL ship the worker runtime (`worker-entry.js` plus its resolved Node dependencies) from the orchestrator's filesystem via a read-only bind-mount at `/opt/furnace`, with the container's CMD overridden to `node /opt/furnace/worker-entry.js`. The per-repo devcontainer image MUST NOT contain any furnace-specific code or CMD; updating the worker bundle MUST NOT require rebuilding per-repo images. A `npm run build:worker` script (or equivalent) MUST produce the bundle directory the orchestrator deploys.

#### Scenario: Image is reused across worker bundle changes

- **WHEN** the worker bundle is updated and redeployed alongside the orchestrator
- **THEN** the next attempt's container launch uses the unchanged per-repo image with the new bundle bind-mounted, with no per-repo image rebuild

#### Scenario: CMD invokes the bundled entrypoint

- **WHEN** a container worker is launched
- **THEN** its main process is `node /opt/furnace/worker-entry.js` reading code from the read-only bind-mount, not from inside the image

### Requirement: Container launch is performed by an orchestrator activity

The system SHALL provide a `launchWorkerContainer({ ticket, phase, attempt })` activity registered on the orchestrator worker. The activity MUST resolve the digest-pinned `imageRef` from `build/<slug>/manifest.json`, run `docker run --rm -d` with the env vars (`WORKER_REPO`, `WORKER_LANGUAGES`, `WORKER_TOOLS`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_ATTEMPT_ID`) and mounts described above, no published ports, and return a container ID and queue name once the launch command has succeeded. The activity MUST NOT wait for the worker to register on the queue.

#### Scenario: Launch returns after docker run -d exits

- **WHEN** `launchWorkerContainer` is invoked for a known repo slug
- **THEN** the activity runs `docker run --rm -d` with the digest-pinned image and required env/mounts, and returns `{ containerId, queue: "repo-${slug}-worker" }` without awaiting worker registration

#### Scenario: Launch fails fast on Docker errors

- **WHEN** the Docker daemon is unavailable or the image cannot be resolved
- **THEN** the activity throws an error visible in Temporal workflow history, and Temporal applies the retry policy rather than silently leaving the queue unclaimed

### Requirement: Per-ticket workflow launches a fresh container per phase attempt

The system SHALL ensure the per-ticket workflow calls `launchWorkerContainer` immediately before each phase activity invocation, so that every phase attempt corresponds to exactly one container launch. If a phase activity is retried by Temporal, the workflow MUST trigger a fresh `launchWorkerContainer` call so the retry runs in a new container — never on the previous container.

#### Scenario: Each phase invocation launches its own container

- **WHEN** the per-ticket workflow runs through spec, coder, and review phases on first attempt
- **THEN** three distinct `launchWorkerContainer` activity invocations appear in workflow history, one per phase, before each phase activity is scheduled

#### Scenario: Phase retries land on a fresh container

- **WHEN** a phase activity fails or is cancelled and Temporal retries it within the configured retry policy
- **THEN** the workflow schedules a new `launchWorkerContainer` for the retry attempt, and the retried phase activity runs on the newly-launched container, not a re-used one

### Requirement: Workflow input carries the target repo slug

The system SHALL extend `PerTicketWorkflowInput` with a required `targetRepoSlug: string` field. The workflow MUST use this slug to derive the per-repo task queue name for all phase activities. If the slug is missing or does not match an entry in `build/repos.json`, the workflow MUST fail fast in spec-phase setup with an actionable error before any container is launched.

#### Scenario: Workflow dispatches phases on the per-repo queue

- **WHEN** the per-ticket workflow runs with `targetRepoSlug: "demo"`
- **THEN** every phase activity invocation is dispatched on task queue `repo-demo-worker`, not the orchestrator queue

#### Scenario: Unknown slug surfaces actionable error

- **WHEN** the per-ticket workflow starts with `targetRepoSlug` set to a value not present in `build/repos.json`
- **THEN** the workflow fails before any `launchWorkerContainer` call, and the failure message names the unknown slug
