## 1. Launcher: env passthrough (mount unchanged)

- [ ] 1.1 Extend `LauncherEnv` in `server/src/worker-launcher.ts` with `anthropicApiKey: string | null`, populated from `env.ANTHROPIC_API_KEY` (treat empty string as null).
- [ ] 1.2 In `launchWorkerContainer`, when `anthropicApiKey` is non-null, append `--env ANTHROPIC_API_KEY=<value>` to docker args. Do NOT alter the existing `~/.claude`→`/root/.claude` bind-mount in either branch.
- [ ] 1.3 Confirm the existing worker-bundle mount and all other args remain unchanged; the only diff in the docker arg list is the optional extra `--env` line.

## 2. Startup precondition

- [ ] 2.1 Add `assertWorkerAuthAvailable(env: NodeJS.ProcessEnv = process.env)` exported from `server/src/worker-launcher.ts` that resolves the same `claudeCredsDir` as the launcher and throws an Error naming both `ANTHROPIC_API_KEY` and the resolved directory if neither is viable.
- [ ] 2.2 "Viable" definition: `ANTHROPIC_API_KEY` is set to a non-empty string, OR the credentials directory exists and `fs.readdir` returns at least one entry.
- [ ] 2.3 Wire `assertWorkerAuthAvailable()` into the orchestrator boot path — call it once from `server/src/index.ts` (HTTP server entry) and once from `server/src/temporal/worker.ts` (Temporal worker entry), before either connects to its respective backend.
- [ ] 2.4 Error message MUST be a single line that names both options literally so an operator can grep for it.
- [ ] 2.5 Confirm the `.env` file is loaded by every entrypoint that calls `assertWorkerAuthAvailable` (the existing `tsx --env-file=.env` in `dev`/`start`/`temporal:worker` already covers this — verify, don't add a second loader).

## 3. Tests

- [ ] 3.1 In `server/tests/integration/container-lifecycle.test.ts` (or a sibling unit test if the launcher is unit-tested elsewhere), add a case asserting that with `ANTHROPIC_API_KEY` set, docker args contain `--env ANTHROPIC_API_KEY=...` AND still contain the `~/.claude`→`/root/.claude` bind-mount.
- [ ] 3.2 Add a case asserting that with `ANTHROPIC_API_KEY` unset, docker args contain the `~/.claude`→`/root/.claude` bind-mount and do NOT contain `ANTHROPIC_API_KEY`.
- [ ] 3.3 Add a unit test for `assertWorkerAuthAvailable`: passes when env var is set; passes when creds dir exists and is non-empty; throws with both option names mentioned when neither is true.
- [ ] 3.4 Verify the existing container-lifecycle integration test still passes under the unset-env-var path (which is its current implicit assumption).

## 4. Docs

- [ ] 4.1 Add a "Claude authentication" subsection to `README.md` describing: put `ANTHROPIC_API_KEY=...` in `the-furnace/.env` (already gitignored), which the orchestrator auto-loads via `tsx --env-file=.env`. Mention that `~/.claude` is still mounted for settings/agents/MCP and (on Linux) subscription auth.
- [ ] 4.2 Add a short note in `TESTING.md` for local integration runs: same `.env` flow; do not export the key in the shell unless the runner doesn't pass through `--env-file`.
- [ ] 4.3 Confirm `.env` remains in `.gitignore`. Do NOT add a tracked `.env.example` containing `ANTHROPIC_API_KEY=`; document the variable in README prose instead to avoid normalizing committed example files for secrets.

## 5. Verify

- [ ] 5.1 Run the workspace `npm test` (root) and confirm both new and existing tests pass.
- [ ] 5.2 Manually run the orchestrator on macOS with `ANTHROPIC_API_KEY=...` only in `.env` (not exported in the shell) and verify a worker container launches and the Claude SDK authenticates.
- [ ] 5.3 Manually run the orchestrator with no `ANTHROPIC_API_KEY` and an empty/missing creds dir and verify the startup precondition fires before any container launch, with the error naming both options.
- [ ] 5.4 Confirm `~/.claude`-resident Claude settings/agents are visible inside a launched worker container under both auth paths (e.g., by inspecting `/root/.claude` from a debug shell or via SDK behavior).
