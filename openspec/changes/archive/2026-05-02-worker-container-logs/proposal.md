## Why

Agent containers are launched with `docker run --rm -d` ([server/src/worker-launcher.ts:60-89](server/src/worker-launcher.ts#L60-L89)), so the moment a container exits its stdout/stderr disappears with it. When a spec/coder/review run misbehaves — Claude SDK loop diverges, a tool segfaults, or the worker exits before producing a return value — there is currently nothing to inspect after the fact. Temporal preserves activity return values and heartbeats, but not the unstructured log stream that operators actually need to debug agent behavior.

## What Changes

- Capture container stdout/stderr to a host file that survives `--rm` by bind-mounting `${LOGS_DIR}/${attemptId}/` into the container at `/var/log/furnace`, and wrapping the entrypoint with a shell `tee` so output goes to both the container's stdout (preserving live `docker logs` for dev) and the persisted file.
- Default `LOGS_DIR` to `<repoRoot>/data/logs`, mirroring the existing `data/pglite` host-dir convention; allow override via `LOGS_DIR` env var.
- Update the `container-worker-lifecycle` capability requirements that constrain mounts (currently only `~/.claude` and the worker bundle) and that constrain CMD (currently bare `node /opt/furnace/worker-entry.js`) to admit the new log-mount and the shell wrapper.
- Add `data/logs/` to `.gitignore` (with a tracked `.gitkeep`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `container-worker-lifecycle`: Mount-set requirement expands to include the per-attempt log directory (read-write); CMD requirement allows a `sh -c` wrapper that tees worker output to the mounted log file; a new requirement covers the log-file persistence behavior itself.

## Impact

- Code: [server/src/worker-launcher.ts](server/src/worker-launcher.ts) (env, mkdir, mount arg, CMD wrapper, new `logsPath` in `LaunchWorkerContainerResult`); [server/src/temporal/activities/worker-launcher.ts](server/src/temporal/activities/worker-launcher.ts) (passthrough of `logsPath`).
- Tests: [server/tests/integration/worker-launcher.test.ts](server/tests/integration/worker-launcher.test.ts) (or wherever the launcher integration test lives) — assert mount + log file content.
- Filesystem: New host directory `data/logs/<attemptId>/container.log` per attempt. Local-only; not git-tracked.
- No new dependencies. No DB schema change. No external infra (Loki/Fluentd/OTel deferred to V1+ per [openspec/roadmap.md:159-170](openspec/roadmap.md#L159-L170)).
- Attempt → log file is resolvable purely from `attempts.id` via the deterministic path; explicitly chose not to persist `logsPath` on the `attempts` row to avoid a redundant schema migration.
