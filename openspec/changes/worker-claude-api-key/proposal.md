## Why

On macOS, Claude Code stores subscription credentials in the system Keychain, not in `~/.claude`. The current worker-launcher bind-mounts `~/.claude` read-only into each worker container as the sole auth source — on Mac that mount has no credentials, the Claude SDK has no auth, and every phase activity fails. Operators on Mac cannot run the orchestrator end-to-end today.

The orchestrator already loads a local `.env` file via `tsx --env-file=.env` in the `dev`, `start`, and `temporal:worker` npm scripts, so any variable placed in `.env` is in `process.env` by the time the launcher runs. We can use that to forward an Anthropic API key into worker containers without adding a dependency or touching boot order.

## What Changes

- Worker launcher reads `ANTHROPIC_API_KEY` from the orchestrator's loaded `process.env` (populated from the orchestrator's `.env` file by the existing `--env-file=.env` tsx flag) and forwards it to spawned worker containers via `docker run --env ANTHROPIC_API_KEY` when set.
- The `~/.claude` bind-mount is retained in BOTH cases so the container has access to operator-level Claude settings, registered agents, MCP server config, and (on Linux) subscription credentials. The env var is purely additive auth, not a replacement for the mount.
- Fail fast at orchestrator startup if NEITHER `ANTHROPIC_API_KEY` is loaded NOR the resolved `~/.claude` (or `CLAUDE_CREDS_DIR`) directory exists and is non-empty, so containers do not launch into an obviously-broken auth state.
- Document `.env`-based setup in `README.md` and `TESTING.md`: how to put `ANTHROPIC_API_KEY=...` in `.env` for Mac operators (the file is already in `.gitignore`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `container-worker-lifecycle`: The Claude credentials requirement is generalized — the bind-mount of `~/.claude` is retained as the source of settings/agents/subscription-creds, and an additional auth source is introduced where the orchestrator forwards `ANTHROPIC_API_KEY` from its loaded environment to the container when present. A new precondition requires at least one viable auth source before any container launch.

## Impact

- Affected code: `server/src/worker-launcher.ts` (env passthrough, startup precondition check, exported boot helper).
- Affected code: `server/src/index.ts` (or whichever entrypoint(s) start the Temporal worker) to call the new precondition once at boot.
- Affected tests: `server/tests/integration/container-lifecycle.test.ts` and any sibling unit tests that assert the docker args.
- Affected docs: `README.md`, `TESTING.md`.
- No new dependencies (`.env` loading is already wired through `tsx --env-file=.env`). No DB migrations. No Temporal contract changes. No changes to the per-repo devcontainer images.
