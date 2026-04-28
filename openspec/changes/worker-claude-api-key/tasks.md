## 1. Launcher: env passthrough (mount unchanged)

- [x] 1.1 Extend `LauncherEnv` in `server/src/worker-launcher.ts` with `anthropicApiKey: string | null` AND `claudeCodeOauthToken: string | null`, populated from `env.ANTHROPIC_API_KEY` and `env.CLAUDE_CODE_OAUTH_TOKEN` respectively (treat empty string as null in both cases).
- [x] 1.2 In `launchWorkerContainer`, when `claudeCodeOauthToken` is non-null, append `--env CLAUDE_CODE_OAUTH_TOKEN=<value>` to docker args. When `anthropicApiKey` is non-null, append `--env ANTHROPIC_API_KEY=<value>`. Both can be appended in the same launch. Do NOT alter the existing `~/.claude`→`/root/.claude` bind-mount in any branch.
- [x] 1.3 Confirm the existing worker-bundle mount and all other args remain unchanged; the only diff in the docker arg list is the optional extra `--env` lines.

## 2. Startup precondition

- [x] 2.1 Add `assertWorkerAuthAvailable(env: NodeJS.ProcessEnv = process.env)` exported from `server/src/worker-launcher.ts` that resolves the same `claudeCredsDir` as the launcher and throws an Error naming `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, and the resolved directory if none is viable.
- [x] 2.2 "Viable" definition: `CLAUDE_CODE_OAUTH_TOKEN` is set to a non-empty string, OR `ANTHROPIC_API_KEY` is set to a non-empty string, OR the credentials directory exists and `fs.readdir` returns at least one entry.
- [x] 2.3 Wire `assertWorkerAuthAvailable()` into the orchestrator boot path — call it once from `server/src/index.ts` (HTTP server entry) and once from `server/src/temporal/worker.ts` (Temporal worker entry), before either connects to its respective backend.
- [x] 2.4 Error message MUST be a single line that names all three options literally so an operator can grep for them.
- [x] 2.5 Confirm the `.env` file is loaded by every entrypoint that calls `assertWorkerAuthAvailable` (the existing `tsx --env-file=.env` in `dev`/`start`/`temporal:worker` already covers this — verify, don't add a second loader).

## 3. Tests

- [x] 3.1 In `server/tests/worker-launcher.test.ts`, add a case asserting that with `ANTHROPIC_API_KEY` set, docker args contain `--env ANTHROPIC_API_KEY=...` AND still contain the `~/.claude`→`/root/.claude` bind-mount.
- [x] 3.2 Add a case asserting that with both auth env vars unset, docker args contain the `~/.claude`→`/root/.claude` bind-mount and do NOT contain either env var.
- [x] 3.3 Add a unit test for `assertWorkerAuthAvailable`: passes when `ANTHROPIC_API_KEY` is set; passes when creds dir exists and is non-empty; throws naming all three option names when none is true.
- [x] 3.4 Add a case asserting that with `CLAUDE_CODE_OAUTH_TOKEN` set, docker args contain `--env CLAUDE_CODE_OAUTH_TOKEN=...` AND still contain the `~/.claude`→`/root/.claude` bind-mount.
- [x] 3.5 Add a case asserting that with BOTH `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` set, docker args contain both `--env` pairs.
- [x] 3.6 Extend the `assertWorkerAuthAvailable` unit tests: passes when `CLAUDE_CODE_OAUTH_TOKEN` is set with empty creds dir; throws message contains `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, and the resolved creds dir.
- [x] 3.7 Verify the existing container-lifecycle integration test still passes under the all-unset path (which is its current implicit assumption).

## 4. Docs

- [x] 4.1 Add a "Claude authentication" subsection to `README.md` describing the three auth sources: `CLAUDE_CODE_OAUTH_TOKEN` (recommended for Mac operators on Pro/Max — generate via `claude setup-token`), `ANTHROPIC_API_KEY` (metered API billing), and the `~/.claude` mount. Both env vars go in `server/.env` (already gitignored), which the orchestrator auto-loads via `tsx --env-file=.env`. Mention that `~/.claude` is still mounted for settings/agents/MCP and (on Linux) subscription auth.
- [x] 4.2 Add a short note in `TESTING.md` for local integration runs covering both env vars: same `.env` flow; do not export either in the shell unless the runner doesn't pass through `--env-file`.
- [x] 4.3 Confirm `.env` remains in `.gitignore`. Do NOT add a tracked `.env.example` containing either secret-shaped variable; document them in README prose instead to avoid normalizing committed example files for secrets.

## 5. Verify

- [x] 5.1 Run the workspace `npm test` (root) and confirm both new and existing tests pass.
- [ ] 5.2 Manually run the orchestrator on macOS with `CLAUDE_CODE_OAUTH_TOKEN=...` only in `server/.env` (not exported in the shell) and verify a worker container launches and the Claude SDK authenticates against the subscription.
- [ ] 5.3 Manually run the orchestrator on macOS with `ANTHROPIC_API_KEY=...` only in `server/.env` and verify a worker container launches and the Claude SDK authenticates via API key.
- [ ] 5.4 Manually run the orchestrator with NONE of the auth sources available (no env vars, empty/missing creds dir) and verify the startup precondition fires before any container launch, with the error naming all three options.
- [ ] 5.5 Confirm `~/.claude`-resident Claude settings/agents are visible inside a launched worker container under all auth paths (e.g., by inspecting `/root/.claude` from a debug shell or via SDK behavior).
