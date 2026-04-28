## Context

The orchestrator launches an ephemeral worker container per phase attempt via `server/src/worker-launcher.ts`. The Claude Agent SDK runs inside that container and authenticates against Anthropic's API. Today the launcher always bind-mounts the host's `~/.claude` (or `$CLAUDE_CREDS_DIR`) read-only at `/root/.claude` so the SDK can pick up the operator's logged-in subscription credentials.

That works on Linux, where `claude login` writes credentials to `~/.claude`. It does NOT work on macOS, where Claude Code stores subscription credentials in the macOS Keychain — the bind-mounted directory may exist but contains no credentials, and the SDK falls through to "no auth available". Mac is a primary developer platform for this project, so the system is unusable end-to-end on the operator's daily-driver machine.

The Claude SDK supports an alternative auth path: when `ANTHROPIC_API_KEY` is set in the container's environment, the SDK uses API-key auth. The orchestrator already loads a local `.env` file via the existing `tsx --env-file=.env` flag in the `dev`, `start`, and `temporal:worker` npm scripts (see `server/package.json`), so any variable placed in `.env` is in `process.env` by the time the launcher runs. Forwarding that env var into the worker container is the smallest fix that unblocks Mac operators without changing boot order or adding a dependency.

The bind-mount itself does more than just auth: when present and non-empty, `~/.claude` may contain operator-level settings, registered agents, MCP server config, and (on Linux) subscription credentials. We retain the mount unconditionally so those non-auth artifacts are still available inside the container — the API-key env var only changes WHERE auth comes from, not what else the SDK can read from disk.

## Goals / Non-Goals

**Goals:**
- Mac operators can run the orchestrator end-to-end by putting `ANTHROPIC_API_KEY=...` in their orchestrator-side `.env` file.
- The key never appears in the host shell's exported environment unless the operator chooses to export it; the canonical source is the gitignored `.env` file the orchestrator already auto-loads.
- Linux operators with `~/.claude` keep working unchanged (no required migration, mount semantics unchanged).
- The container retains access to operator-level Claude settings/agents/MCP regardless of which auth source is in use.
- The orchestrator fails fast at startup if neither auth source is available, instead of letting every phase activity fail silently inside containers.

**Non-Goals:**
- Adding a `dotenv` package dependency. `.env` loading is already provided by tsx's `--env-file` flag, which is sufficient.
- Supporting multiple concurrent Claude accounts or per-attempt key rotation. One operator-wide key.
- Distributing the API key via a secret manager, Vault, or k8s secrets. The `.env` file (or the host process env, which `--env-file` merges into) is the boundary; how the operator gets the key into `.env` is their problem.
- Mounting the macOS Keychain into the container or shelling out to `security find-generic-password`. Both are brittle and out of scope.
- Changing the per-repo devcontainer images. The fix is purely in the orchestrator's `docker run` invocation.

## Decisions

### Decision: Source `ANTHROPIC_API_KEY` from the orchestrator's `.env`, not the host shell

The expected developer flow is to put `ANTHROPIC_API_KEY=...` in `the-furnace/.env` (already gitignored). The existing `tsx --env-file=.env` in the `dev`/`start`/`temporal:worker` scripts loads it into `process.env` before the launcher runs. The launcher then reads it from `process.env` like any other config var.

**Why:** Avoids polluting the operator's shell with a long-lived secret, keeps the key co-located with the project that uses it, and reuses an env-loading mechanism already present in every script that boots the orchestrator. No new code path is required for the loading itself.

**Alternative considered:** Add a `dotenv` dependency and call `dotenv.config()` from `server/src/index.ts`. Rejected — duplicates what `tsx --env-file=.env` already does and adds a dependency for no behavior change.

**Alternative considered:** Require operators to `export ANTHROPIC_API_KEY=...` in their shell. Rejected — leaks the key into every process the operator starts and is a strictly worse default than a project-local `.env`.

### Decision: Always retain the `~/.claude` bind-mount; the env var is purely additive

When `ANTHROPIC_API_KEY` is set, the launcher passes `--env ANTHROPIC_API_KEY=<value>` AND keeps the existing read-only bind-mount of `~/.claude` (or `$CLAUDE_CREDS_DIR`) at `/root/.claude`. The mount continues to provide settings, agents, MCP config, and subscription credentials when present.

**Why:** The mount carries non-auth state (settings, registered agents, MCP servers) that operators rely on independent of how the SDK authenticates. Removing the mount when the env var is set would silently strip those artifacts. The Claude SDK's own resolution order picks the env-key over mounted credentials, so there is no ambiguity about which auth is in use even with both sources present.

**Alternative considered:** Skip the mount when `ANTHROPIC_API_KEY` is set. Rejected — corrected after design feedback; the mount serves more than just credentials.

### Decision: Validate at orchestrator startup, not at container launch

Read auth-source state once when the orchestrator process boots. If `ANTHROPIC_API_KEY` is unset AND the resolved `claudeCredsDir` does not exist or is empty, fail fast with an actionable message naming both options.

**Why:** Discovering "no auth available" at the moment the first ticket fires is too late — it produces a Temporal activity failure that looks like a worker bug. Failing at boot points the operator at their host setup directly. The check is cheap (one `fs.stat` plus `os.readdir`) and runs once.

**Alternative considered:** Check inside the worker container at startup. Rejected — moves the failure further from the operator and doesn't catch misconfiguration before any ticket is claimed.

### Decision: Read the env var inside `worker-launcher.ts`, not at module import time

The launcher already calls `readLauncherEnv(options.env ?? process.env)` per launch. We extend that struct with an optional `anthropicApiKey: string | null` field and consult it when building docker args. The startup precondition check is exposed as an exported function (`assertWorkerAuthAvailable(env)`) called once from the orchestrator's bootstrap.

**Why:** Keeps the launcher injectable for tests (the integration tests already pass a custom `env`) and centralizes auth-source policy in one file.

## Risks / Trade-offs

- **[Risk]** Operators put `ANTHROPIC_API_KEY` in `.env` but the file gets accidentally committed (e.g., a future change removes `.env` from `.gitignore` or someone force-adds it). → **Mitigation:** Confirm `.env` stays in `.gitignore`; do not introduce a tracked example file (`.env.example`) that would normalize having `ANTHROPIC_API_KEY=` lines under version control. Document the variable name in `README.md` instead.
- **[Risk]** Subtle behavioral difference between subscription auth (mount) and API-key auth (env) — e.g., rate limits or model availability. → **Mitigation:** Out of scope for this change; the SDK's behavior under each auth mode is the SDK's concern. We document both as supported.
- **[Risk]** Startup precondition rejects a valid setup we didn't anticipate (e.g., a non-empty `~/.claude` with stale tokens that the SDK rejects). → **Mitigation:** The check only verifies presence and non-emptiness, not validity. Validity failures still surface as activity errors — same as today. We are strictly adding a guardrail, not replacing one.
- **[Risk]** A test or CI runner invokes the orchestrator entrypoint without `--env-file`, missing the `.env` load and tripping the precondition unexpectedly. → **Mitigation:** The precondition's error message names both `ANTHROPIC_API_KEY` and the credentials directory, so the cause is obvious; tests that boot the orchestrator already use the same npm scripts.
- **[Trade-off]** Always mounting plus optionally passing the env var means the docker invocation has two auth-related arguments at once. Acceptable — the SDK's own resolution order disambiguates, and the mount carries non-auth state we want regardless.
