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

The system SHALL connect the container worker to Temporal using `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` from the environment, registering only the phase activities (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`) on the task queue named `repo-${WORKER_REPO}-worker`. The worker MUST NOT register workflow modules or orchestrator-only activities (Linear, ticket state sync, container launch).

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

### Requirement: Container worker stdout/stderr persists to a host-side log file

The system SHALL persist each container worker's combined stdout and stderr to a file on the orchestrator host that survives `docker run --rm`. The orchestrator MUST create a per-attempt directory at `${LOGS_DIR}/${attemptId}/` (default `<repoRoot>/data/logs/${attemptId}/`, override via `LOGS_DIR` env var) before each `launchWorkerContainer` call, MUST bind-mount that directory read-write at `/var/log/furnace` inside the container, and MUST wrap the container's CMD so that worker output is teed to `/var/log/furnace/container.log`. The redirect MUST happen outside the Node process (in a shell wrapper) so that a Node crash, unhandled async rejection, or `kill -9` still leaves the pre-crash output on disk. The teed copy MUST also remain on the container's stdout so that `docker logs <containerId>` continues to surface live output during dev. `launchWorkerContainer` MUST return the host-side `logsPath` alongside `containerId` and `queue`.

#### Scenario: Log file persists after container is removed

- **WHEN** a container worker is launched for `attemptId=abc-123`, runs to completion, and exits (causing `--rm` to delete the container)
- **THEN** the file `${LOGS_DIR}/abc-123/container.log` exists on the host, contains the worker's startup banner and any subsequent output, and remains readable after the container record is gone

#### Scenario: Crash output is captured

- **WHEN** the Node process inside the container is terminated abruptly (e.g., `kill -9` or an uncaught fatal error) mid-run
- **THEN** the host-side log file contains all output emitted up to the moment of termination, because the shell-level tee is not part of the crashed Node process

#### Scenario: Live tailing via docker logs still works

- **WHEN** a container worker is running and an operator runs `docker logs -f <containerId>`
- **THEN** stdout/stderr stream live to the terminal, in addition to being written to the host-side log file

#### Scenario: launchWorkerContainer surfaces the log path

- **WHEN** `launchWorkerContainer({ ticketId, phase, attemptId, repoSlug })` is invoked
- **THEN** the result includes `logsPath` pointing to the per-attempt host directory (e.g., `<repoRoot>/data/logs/<attemptId>`), and the directory exists on disk before the activity returns

### Requirement: Container worker authenticates Claude via host-supplied OAuth token, API key, or mounted credentials

The system SHALL bind-mount the host's `~/.claude` directory (or the directory named by `CLAUDE_CREDS_DIR`) read-only at `/root/.claude` for every worker container. This mount provides operator-level Claude settings, registered agents, MCP server configuration, and (on Linux) subscription credentials.

In addition, when `CLAUDE_CODE_OAUTH_TOKEN` is set in the orchestrator's `process.env` (typically loaded from `server/.env` via the existing `tsx --env-file=.env` flag in the npm boot scripts), the launcher MUST forward it to the container via `docker run --env CLAUDE_CODE_OAUTH_TOKEN`. Likewise, when `ANTHROPIC_API_KEY` is set, the launcher MUST forward it via `docker run --env ANTHROPIC_API_KEY`. Either or both MAY be set; both are purely additive — they do not replace or alter the bind-mount, and the Claude Agent SDK's own resolution order picks one when multiple are present.

The orchestrator MUST validate at startup that at least one viable auth source is available — `CLAUDE_CODE_OAUTH_TOKEN` is set in `process.env`, OR `ANTHROPIC_API_KEY` is set in `process.env`, OR the resolved credentials directory exists and is non-empty — and MUST fail fast with a single-line actionable message naming all three options if none is. No other host paths beyond the worker bundle and the credentials directory are mounted.

#### Scenario: OAuth token is forwarded alongside the credentials mount

- **WHEN** the orchestrator launches a worker container with `CLAUDE_CODE_OAUTH_TOKEN` set in its `process.env` (e.g., loaded from `server/.env`)
- **THEN** the resulting `docker run` invocation includes both `--env CLAUDE_CODE_OAUTH_TOKEN` and a read-only bind-mount of the host credentials directory at `/root/.claude`

#### Scenario: API key env var is forwarded alongside the credentials mount

- **WHEN** the orchestrator launches a worker container with `ANTHROPIC_API_KEY` set in its `process.env` (e.g., loaded from `server/.env`)
- **THEN** the resulting `docker run` invocation includes both `--env ANTHROPIC_API_KEY` and a read-only bind-mount of the host credentials directory at `/root/.claude`

#### Scenario: Both auth env vars are forwarded when both are set

- **WHEN** the orchestrator launches a worker container with BOTH `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` set in its `process.env`
- **THEN** the resulting `docker run` invocation includes both `--env CLAUDE_CODE_OAUTH_TOKEN` and `--env ANTHROPIC_API_KEY`, plus the read-only bind-mount of the host credentials directory

#### Scenario: Credentials directory is mounted when no auth env var is set

- **WHEN** the orchestrator launches a worker container with both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` unset and a non-empty `~/.claude` (or `CLAUDE_CREDS_DIR`) on the host
- **THEN** the resulting `docker run` invocation bind-mounts that directory read-only at `/root/.claude` and does not pass either env var

#### Scenario: Orchestrator startup fails when no auth source is available

- **WHEN** the orchestrator process starts with `CLAUDE_CODE_OAUTH_TOKEN` unset AND `ANTHROPIC_API_KEY` unset AND the resolved credentials directory missing or empty
- **THEN** the orchestrator exits non-zero with a single-line error naming `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, and the expected credentials directory, before any worker container is launched

#### Scenario: No additional host filesystem leaks into the container

- **WHEN** a worker container is launched
- **THEN** the only host bind-mounts are the orchestrator's worker bundle directory (read-only) and the Claude credentials directory (read-only); no other host paths are exposed

### Requirement: Worker bundle is bind-mounted, not baked into the image

The system SHALL ship the worker runtime (`worker-entry.js` plus its resolved Node dependencies) from the orchestrator's filesystem via a read-only bind-mount at `/opt/furnace`. The container's CMD MUST invoke the bundled entrypoint via a shell wrapper that tees output to the persisted log file: `sh -c 'exec node /opt/furnace/worker-entry.js 2>&1 | tee /var/log/furnace/container.log'`. The `exec` MUST replace the shell with the Node process so that signals (SIGTERM, SIGINT) still reach Node directly. The per-repo devcontainer image MUST NOT contain any furnace-specific code or CMD; updating the worker bundle MUST NOT require rebuilding per-repo images. A `npm run build:worker` script (or equivalent) MUST produce the bundle directory the orchestrator deploys.

#### Scenario: Image is reused across worker bundle changes

- **WHEN** the worker bundle is updated and redeployed alongside the orchestrator
- **THEN** the next attempt's container launch uses the unchanged per-repo image with the new bundle bind-mounted, with no per-repo image rebuild

#### Scenario: CMD invokes the bundled entrypoint through a tee wrapper

- **WHEN** a container worker is launched
- **THEN** its top-level process is `sh -c 'exec node /opt/furnace/worker-entry.js 2>&1 | tee /var/log/furnace/container.log'`, the Node process reads code from the read-only bind-mount, and combined stdout/stderr is written to both the container's stdout and the persisted log file

#### Scenario: Signals reach the Node process

- **WHEN** the container receives SIGTERM (e.g., from `docker stop`)
- **THEN** the signal is delivered to the Node process (because `exec` replaced the shell), and the cooperative-cancellation flow defined by the SIGTERM-handling requirement still executes

### Requirement: Container launch is performed by an orchestrator activity

The system SHALL provide a `launchWorkerContainer({ ticket, phase, attempt })` activity registered on the orchestrator worker. The activity MUST resolve the digest-pinned `imageRef` from `build/<slug>/manifest.json`, run `docker run --rm -d` with the env vars (`WORKER_REPO`, `WORKER_LANGUAGES`, `WORKER_TOOLS`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_ATTEMPT_ID`) and mounts described above, no published ports, and return a container ID, queue name, and host-side log path once the launch command has succeeded. The activity MUST NOT wait for the worker to register on the queue.

#### Scenario: Launch returns after docker run -d exits

- **WHEN** `launchWorkerContainer` is invoked for a known repo slug
- **THEN** the activity runs `docker run --rm -d` with the digest-pinned image and required env/mounts, and returns `{ containerId, queue: "repo-${slug}-worker", logsPath }` without awaiting worker registration

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
