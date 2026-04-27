## Why

Concept §3.3 and §3.6: collapsing worker lifecycle and sandbox lifecycle into a single event makes cleanup a free side-effect of task completion, and per-attempt (not per-ticket) ephemerality eliminates state-drift across retries. This change implements that lifecycle.

## What Changes

- Add a container entrypoint (`server/src/worker-entry.ts`) that:
  1. Reads capability metadata from env (`WORKER_LANGUAGES`, `WORKER_TOOLS`, `WORKER_REPO`).
  2. Connects to Temporal with a task queue matching its capabilities (e.g., `repo-foo-worker`).
  3. Registers the phase-level activities it can execute.
  4. Claims one matching task, executes it, and exits — single-task worker lifetime.
- Add a dispatch helper in workflow code that routes activities to the correct task queue based on the target repo.
- Add graceful-death handling: on SIGTERM during activity execution, report progress and let Temporal retry on a fresh container.
- Mount `~/.claude` read-only into the container for Claude SDK subscription auth (per concept §2 Authentication).
- Add integration tests exercising the full lifecycle against a local Temporal instance.

## Capabilities

### New Capabilities

- `container-worker-lifecycle`: Container boot → capability self-registration → single-task claim → graceful death; worker lifecycle equals sandbox lifecycle.

### Modified Capabilities

- `orchestration-substrate`: Task queue routing now depends on capability metadata published by containers.

## Impact

- Depends on: `temporal-setup`, `devcontainer-images`.
- New files: `server/src/worker-entry.ts`, `server/src/temporal/dispatch.ts`, `server/tests/integration/container-lifecycle.test.ts`.
- Base devcontainer images (from `devcontainer-images`) invoke `worker-entry.ts` as their CMD.
- Mount contract: host `~/.claude` → container `/root/.claude` (read-only).
