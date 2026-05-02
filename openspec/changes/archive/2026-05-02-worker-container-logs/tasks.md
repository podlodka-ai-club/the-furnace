## 1. Host log directory and gitignore

- [x] 1.1 Add `data/logs/.gitkeep` (tracked) to seed the directory
- [x] 1.2 Update `.gitignore` to ignore `data/logs/*` while preserving `data/logs/.gitkeep` (mirror the existing `data/pglite/*` rule)

## 2. Launcher: env, mkdir, mount, CMD wrapper

- [x] 2.1 In [server/src/worker-launcher.ts](server/src/worker-launcher.ts), add `logsDir: string` to `LauncherEnv`; default to `path.join(repoRoot, "data", "logs")`, override via `LOGS_DIR` env var (mirror the existing `WORKER_BUNDLE_DIR` / `BUILD_DIR` pattern at [worker-launcher.ts:96-113](server/src/worker-launcher.ts#L96-L113))
- [x] 2.2 Compute `attemptLogsDir = path.join(env.logsDir, input.attemptId)` and `await mkdir(attemptLogsDir, { recursive: true })` before constructing the docker args
- [x] 2.3 Append `--mount type=bind,source=${attemptLogsDir},target=/var/log/furnace` to the docker args (no `,readonly` — must be writable)
- [x] 2.4 Replace the trailing `node /opt/furnace/worker-entry.js` argv with `sh -c 'exec node /opt/furnace/worker-entry.js 2>&1 | tee /var/log/furnace/container.log'` so the redirect happens outside Node and stdout still tees to the docker log driver
- [x] 2.5 Add `logsPath: string` to `LaunchWorkerContainerResult` and return `attemptLogsDir` from `launchWorkerContainer`
- [x] 2.6 Re-export the updated result type unchanged from [server/src/temporal/activities/worker-launcher.ts](server/src/temporal/activities/worker-launcher.ts) (the `export type { ... LaunchWorkerContainerResult }` already covers the new field)

## 3. Tests

- [x] 3.1 Extend the launcher unit/integration tests to assert: (a) the `--mount type=bind,source=...,target=/var/log/furnace` arg is present, (b) the per-attempt directory exists on disk after `launchWorkerContainer` returns, (c) the result includes `logsPath` pointing at that directory, (d) the trailing argv invokes `sh -c '... | tee /var/log/furnace/container.log'`
- [x] 3.2 Adapt the existing integration test that stubs `runDocker` to spawn the worker entry as a child process ([worker-launcher.ts:46-48](server/src/worker-launcher.ts#L46-L48)) so the stub redirects child stdout/stderr through the same tee logic, then assert the host-side `container.log` exists and contains the `[container-worker] starting ...` startup banner from [worker-entry.ts:76-77](server/src/worker-entry.ts#L76-L77)

## 4. Manual smoke

- [ ] 4.1 `npm run --prefix server temporal:worker` to boot the orchestrator (the worker that registers `launchWorkerContainer` and the per-ticket workflow). `npm run dev` only starts the Express `/health` app and does not launch containers.
- [ ] 4.2 Trigger a Linear ticket with `agent-ready` + `repo:<slug>`; let the spec phase container spin up and exit
- [ ] 4.3 `ls data/logs/<attemptId>/container.log` — confirm the file exists
- [ ] 4.4 `cat data/logs/<attemptId>/container.log` — confirm the startup banner and any subsequent agent output is present
- [ ] 4.5 Force a failure (e.g. invalid `WORKER_REPO`) and confirm the failure trace lands in `container.log` even though the container `--rm`'d
- [ ] 4.6 Crash check: `docker exec` into a long-running test container and `kill -9` the Node process; confirm output up to the kill is present in `container.log` (the shell-level `tee` survives the Node crash)

## 5. Validate

- [x] 5.1 `openspec validate worker-container-logs` returns no errors
- [x] 5.2 `npm test` and `npm run typecheck` pass
