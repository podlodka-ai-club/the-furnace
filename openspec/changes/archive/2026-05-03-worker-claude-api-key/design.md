## Context

The orchestrator launches an ephemeral worker container per phase attempt via `server/src/worker-launcher.ts`. The Claude Agent SDK runs inside that container and authenticates against Anthropic's API. Today the launcher always bind-mounts the host's `~/.claude` (or `$CLAUDE_CREDS_DIR`) read-only at `/root/.claude` so the SDK can pick up the operator's logged-in subscription credentials.

That works on Linux, where `claude login` writes credentials to `~/.claude`. It does NOT work on macOS, where Claude Code stores subscription credentials in the macOS Keychain — the bind-mounted directory may exist but contains no credentials, and the SDK falls through to "no auth available". Mac is a primary developer platform for this project, so the system is unusable end-to-end on the operator's daily-driver machine.

The Claude Agent SDK supports two env-var auth paths in addition to the credentials directory:

1. `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived OAuth token bound to the operator's Claude Pro/Max subscription, generated once via `claude setup-token`. Same billing as `claude login` (subscription, no metered API charges), portable across machines, and works inside a container without touching the macOS Keychain.
2. `ANTHROPIC_API_KEY` — a standard Anthropic API key with metered per-token billing.

The orchestrator already loads `server/.env` via the existing `tsx --env-file=.env` flag in the `dev`, `start`, and `temporal:worker` npm scripts (see `server/package.json`), so any variable placed there is in `process.env` by the time the launcher runs. Forwarding either env var into the worker container is the smallest fix that unblocks Mac operators without changing boot order or adding a dependency.

The bind-mount itself does more than just auth: when present and non-empty, `~/.claude` may contain operator-level settings, registered agents, MCP server config, and (on Linux) subscription credentials. We retain the mount unconditionally so those non-auth artifacts are still available inside the container — the API-key env var only changes WHERE auth comes from, not what else the SDK can read from disk.

## Goals / Non-Goals

**Goals:**
- Mac operators can run the orchestrator end-to-end by putting `CLAUDE_CODE_OAUTH_TOKEN=...` (recommended for Pro/Max subscribers) or `ANTHROPIC_API_KEY=...` in their orchestrator-side `server/.env` file.
- Neither token nor key has to appear in the host shell's exported environment; the canonical source is the gitignored `server/.env` the orchestrator already auto-loads.
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

### Decision: Source auth env vars from `server/.env`, not the host shell

The expected developer flow is to put `CLAUDE_CODE_OAUTH_TOKEN=...` (recommended for Pro/Max subscribers) or `ANTHROPIC_API_KEY=...` in `server/.env` (already gitignored). The existing `tsx --env-file=.env` in the `dev`/`start`/`temporal:worker` scripts loads them into `process.env` before the launcher runs. The launcher then reads them from `process.env` like any other config var.

**Why:** Avoids polluting the operator's shell with long-lived secrets, keeps them co-located with the project that uses them, and reuses an env-loading mechanism already present in every script that boots the orchestrator. No new code path is required for the loading itself.

**Alternative considered:** Add a `dotenv` dependency and call `dotenv.config()` from `server/src/index.ts`. Rejected — duplicates what `tsx --env-file=.env` already does and adds a dependency for no behavior change.

**Alternative considered:** Require operators to `export` the value in their shell. Rejected — leaks the secret into every process the operator starts and is a strictly worse default than a project-local `.env`.

### Decision: Support both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`

The launcher forwards each env var independently when set. Both can be present at once; the Claude Agent SDK's own resolution order picks one (OAuth-token-bound subscription auth is preferred when present). `CLAUDE_CODE_OAUTH_TOKEN` is the recommended default for individual operators on Pro/Max because it bills against the existing subscription instead of metered API tokens; `ANTHROPIC_API_KEY` is the right choice when the operator wants metered billing or doesn't have a subscription.

**Why:** The cost difference between subscription billing and metered API billing is large for an autonomous worker fleet. Forcing operators onto `ANTHROPIC_API_KEY` would burn through API credits unnecessarily for the most common solo-developer setup. Supporting both lets each operator choose; the launcher does not need to disambiguate because the SDK already does.

**Alternative considered:** Support only `CLAUDE_CODE_OAUTH_TOKEN`. Rejected — operators without a Claude subscription (or who want explicit metered billing for cost attribution) need an API-key path.

**Alternative considered:** Support only `ANTHROPIC_API_KEY`. Rejected — see above; this is the original design and was the gap that prompted this amendment.

### Decision: Always retain the `~/.claude` bind-mount; the env vars are purely additive

When either auth env var is set, the launcher passes the corresponding `--env <NAME>=<value>` AND keeps the existing read-only bind-mount of `~/.claude` (or `$CLAUDE_CREDS_DIR`) at `/root/.claude`. The mount continues to provide settings, agents, MCP config, and subscription credentials when present.

**Why:** The mount carries non-auth state (settings, registered agents, MCP servers) that operators rely on independent of how the SDK authenticates. Removing the mount when an env var is set would silently strip those artifacts. The Claude SDK's own resolution order picks the env credentials over mounted credentials, so there is no ambiguity about which auth is in use even with multiple sources present.

**Alternative considered:** Skip the mount when an auth env var is set. Rejected — corrected after design feedback; the mount serves more than just credentials.

### Decision: Validate at orchestrator startup, not at container launch

Read auth-source state once when the orchestrator process boots. If NONE of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or a non-empty `claudeCredsDir` is available, fail fast with an actionable message naming all three options.

**Why:** Discovering "no auth available" at the moment the first ticket fires is too late — it produces a Temporal activity failure that looks like a worker bug. Failing at boot points the operator at their host setup directly. The check is cheap (a couple of env reads plus one `os.readdir`) and runs once.

**Alternative considered:** Check inside the worker container at startup. Rejected — moves the failure further from the operator and doesn't catch misconfiguration before any ticket is claimed.

### Decision: Read the env vars inside `worker-launcher.ts`, not at module import time

The launcher already calls `readLauncherEnv(options.env ?? process.env)` per launch. We extend that struct with `claudeCodeOauthToken: string | null` and `anthropicApiKey: string | null` fields and consult them when building docker args. The startup precondition check is exposed as an exported function (`assertWorkerAuthAvailable(env)`) called once from the orchestrator's bootstrap.

**Why:** Keeps the launcher injectable for tests (the integration tests already pass a custom `env`) and centralizes auth-source policy in one file.

## Risks / Trade-offs

- **[Risk]** Operators put `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in `.env` but the file gets accidentally committed (e.g., a future change removes `.env` from `.gitignore` or someone force-adds it). → **Mitigation:** Confirm `.env` stays in `.gitignore`; do not introduce a tracked example file (`.env.example`) that would normalize secret-looking lines under version control. Document the variable names in `README.md` instead.
- **[Risk]** Subtle behavioral difference between subscription auth (OAuth token or mount) and API-key auth — e.g., rate limits, weekly subscription caps, or model availability. → **Mitigation:** Out of scope for this change; the SDK's behavior under each auth mode is the SDK's concern. We document all three as supported.
- **[Risk]** Startup precondition rejects a valid setup we didn't anticipate (e.g., a non-empty `~/.claude` with stale tokens that the SDK rejects). → **Mitigation:** The check only verifies presence and non-emptiness, not validity. Validity failures still surface as activity errors — same as today. We are strictly adding a guardrail, not replacing one.
- **[Risk]** A test or CI runner invokes the orchestrator entrypoint without `--env-file`, missing the `.env` load and tripping the precondition unexpectedly. → **Mitigation:** The precondition's error message names `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, and the credentials directory, so the cause is obvious; tests that boot the orchestrator already use the same npm scripts.
- **[Trade-off]** Always mounting plus optionally passing one or both env vars means the docker invocation may carry several auth-related arguments at once. Acceptable — the SDK's own resolution order disambiguates, and the mount carries non-auth state we want regardless.
