## Context

Per-attempt agent containers are short-lived: launched via `docker run --rm -d`, they self-shut after a single phase activity ([server/src/worker-entry.ts:21-45](server/src/worker-entry.ts#L21-L45)) and the `--rm` flag deletes them on exit. Today the only artifacts that outlive the container are Temporal activity return values, heartbeat liveness signals, and DB rows in `workflow_runs`/`attempts`/`reviews`. Stdout/stderr — the place where Claude SDK chatter, tool errors, and crash traces live — is gone the moment the container exits.

There is no logger module today; the codebase uses bare `console.log`/`console.error`. The planned [provenance-store](openspec/changes/provenance-store/proposal.md) addresses *structured tool outputs*, not unstructured streams.

## Goals / Non-Goals

**Goals:**
- A container's stdout and stderr are persisted to a host-side file that survives the container's deletion.
- The persisted file is reachable from `attempts.id` alone, with no DB lookup, so debugging works even if DB writes failed.
- Live `docker logs <id>` continues to work during dev for tailing in-flight runs.
- Capture survives Node-process crashes and signal kills (the redirect happens in the shell, not in Node).
- Zero new external infrastructure (no Loki, Fluentd, OTel collector).

**Non-Goals:**
- Log rotation / retention policy. (V1+ concern, mirrors the provenance-store stance.)
- A structured logger refactor of `console.*` call sites. Separate change.
- Shipping logs to an aggregator (Loki / OTel). On the V1+ roadmap.
- A CLI/UI for log search. `cat data/logs/<attemptId>/container.log` is sufficient for v0.
- Persisting bytes into the database or an object store. Defer to a v0.5 follow-up uploader once provenance-store lands.

## Decisions

### D1. Bind-mount a per-attempt host directory for log capture

Mount `${LOGS_DIR}/${attemptId}/` (default `<repoRoot>/data/logs/<attemptId>/`) into the container at `/var/log/furnace`, read-write. The orchestrator creates the directory before `docker run`.

**Why this over alternatives:**
- *vs. dropping `--rm` and using `docker logs` after the fact*: Drop-`--rm` requires a new orchestrator activity to wait, collect, and `docker rm`, plus a zombie-container failure mode if the orchestrator crashes between wait and rm. The bind-mount avoids both.
- *vs. shipping to Loki/Fluentd*: New infra dependency. Disproportionate for a project that has no structured logger yet.
- *vs. heartbeat-payload / HTTP sink from a structured logger*: Touches every `console.*` call site, and loses output from native subprocesses, signals, and Node crashes. Below the abstraction we want.
- *vs. `--log-driver=local`*: `--rm` deletes the per-container log files along with the container — defeated by our launch flags.

### D2. Wrap the entrypoint with `sh -c '... | tee'` rather than redirecting in Node

Replace the container CMD `node /opt/furnace/worker-entry.js` with `sh -c 'exec node /opt/furnace/worker-entry.js 2>&1 | tee /var/log/furnace/container.log'`.

**Why:**
- The redirect happens *outside* the Node process, so a Node crash, `kill -9`, or unhandled async rejection still leaves whatever was emitted before the crash in the file.
- `tee` (not `>`) preserves stdout, so `docker logs <containerId>` continues to work for live tailing — this matters during dev. Confirmed with the user.
- `exec` replaces the shell with Node, so signal handling (SIGTERM from `docker stop`) still reaches the Node process directly, preserving the cooperative-cancellation behavior described in [container-worker-lifecycle/spec.md:56-68](openspec/specs/container-worker-lifecycle/spec.md#L56-L68).
- Using `2>&1 | tee` interleaves stderr and stdout in time order in the file — the right behavior for debugging.

### D3. Path scheme: flat by `attemptId`, not nested by repo

`data/logs/<attemptId>/container.log`, not `data/logs/<repoSlug>/<attemptId>/container.log`. `attemptId` is already globally unique (UUID generated per attempt). Confirmed with the user.

**Why:** Path is derivable from a single id that is already plumbed end-to-end via `WORKER_ATTEMPT_ID`. Nesting by repo adds no information that `attempts.run_id → workflow_runs.ticket_id` couldn't recover.

### D4. Do **not** persist `logsPath` on the `attempts` row

The path is deterministic from `attempts.id`. Storing it as a column would require a migration and would duplicate information. Skipped for v0.

**Trade-off:** If we ever change the path scheme (e.g., move to per-repo nesting, or to an object-store URL when v0.5 lands), older attempts would point at the old scheme implicitly. Acceptable: the scheme is small and v0.5's uploader can record canonical URLs in the new provenance/log table at that time.

### D5. `LOGS_DIR` defaults to `<repoRoot>/data/logs`, follows existing conventions

Mirrors `data/pglite/` (current) and the planned `data/provenance/`. Add `data/logs/` to `.gitignore` with a tracked `.gitkeep`, matching how [data/pglite/.gitkeep](data/pglite/.gitkeep) is handled per [data-persistence/spec.md:129-146](openspec/specs/data-persistence/spec.md#L129-L146).

### D6. Mount mode is read-write, not read-only

Unlike `~/.claude` (read-only) and `/opt/furnace` (read-only), the log mount must be writable so `tee` can append. Limit blast radius by mounting only the *per-attempt* subdirectory, not the whole `data/logs/` tree — a misbehaving container can only stomp on its own attempt's directory.

## Risks / Trade-offs

- **[Risk] Tee buffering on crash**: `tee` is line-buffered when its stdout is a pipe; in our case stdout is the docker log driver which is a pipe, so line-buffering should hold. A hard SIGKILL of `tee` itself could lose its in-flight buffer. → Acceptable. We get strictly better than today (where we lose everything).
- **[Risk] Disk fill from runaway logs**: No rotation in v0. A pathological agent loop could fill `data/logs/`. → Mitigated for dev by short-lived attempts; in prod, V1+ rotation/retention is on the roadmap. Operator can `rm -rf data/logs/` at any time without affecting Temporal/DB state.
- **[Risk] `LOGS_DIR` permission mismatch between host and container**: The container runs as root (per `target=/root/.claude` in the existing mount), so it has write access to any host-owned dir. → No issue with the default. Document that custom `LOGS_DIR` must be writable by the docker user.
- **[Risk] `attemptId` collision across runs of `npm run dev`**: Should not happen — UUIDs. But if a developer manually replays an attempt with the same id, logs will append. → Acceptable; the file remains a coherent ordered log.
- **[Risk] Native subprocesses bypassing tee**: A child process that writes to its own tty or directly to a different fd would skip the file. → No such path exists today; phase activities go through Node.

## Migration Plan

No data migration. Pure additive change to launch arguments and a new host directory.

**Rollout:**
1. Land the launcher change.
2. `mkdir -p data/logs && touch data/logs/.gitkeep`, update `.gitignore`.
3. Run an integration test attempt to confirm `data/logs/<attemptId>/container.log` populates.
4. No coordinated deploy required — the next container launch picks up the new behavior.

**Rollback:** Revert the launcher change. Existing log files are inert; deleting `data/logs/` is safe.
