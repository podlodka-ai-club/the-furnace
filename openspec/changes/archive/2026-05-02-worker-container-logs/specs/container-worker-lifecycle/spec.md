## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Container worker mounts host Claude credentials read-only

The system SHALL launch each container worker with the host's `~/.claude` directory bind-mounted read-only at `/root/.claude`, so Claude SDK calls inside the container reuse the operator's subscription auth without copying credentials onto disk inside the container. The only other host paths permitted as bind-mounts are the worker bundle directory (read-only, see worker-bundle requirement) and the per-attempt log directory (read-write, see log-persistence requirement). No other host paths SHALL be mounted.

#### Scenario: Claude credentials directory is available read-only

- **WHEN** a container worker is launched
- **THEN** `/root/.claude` exists inside the container, is backed by the host's `~/.claude`, and is read-only

#### Scenario: No additional host filesystem leaks into the container

- **WHEN** a container worker is launched
- **THEN** the container's host bind-mounts are exactly: `~/.claude` (read-only), the orchestrator's worker bundle directory (read-only), and the per-attempt log directory `${LOGS_DIR}/${attemptId}` (read-write at `/var/log/furnace`) — and nothing else

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
