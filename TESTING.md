# Testing

## Default path

For code changes, run the full suite from the repo root:

```bash
docker compose up -d temporal temporal-ui
TEMPORAL_TASK_QUEUE=local-test npm test
```

`npm test` and `npm run test` are equivalent at the root. Both run `package.json`'s `test` script: the server Vitest suite first, then the root devcontainer build-script tests.

Use `TEMPORAL_TASK_QUEUE=local-test` when a local app worker may already be running on the default `the-furnace` queue. Workflow tests create their own Temporal workers, so do not start `npm run --prefix server temporal:worker` just to run tests.

Documentation-only changes do not need code tests when no runtime files changed; state that clearly in the final response.

## Command matrix

| Command | What it runs |
|---|---|
| `docker compose up -d temporal temporal-ui` | Starts local Temporal services required by workflow tests and local orchestration |
| `TEMPORAL_TASK_QUEUE=local-test npm test` | Default full verification for code changes; isolates test workflows from a running app worker |
| `npm test` / `npm run test` | Same full suite without queue override; use only when no default-queue app worker is running |
| `npm run --prefix server test` | Server Vitest suite once; includes server integration/workflow tests |
| `npm run --prefix server test -- tests/integration/linear.test.ts` | One server test file |
| `npm run --prefix server test:watch` | Server Vitest watch mode for active development; not final verification |
| `npm run test:devcontainer` | Root devcontainer build-script tests only; already included in `npm test` |
| `npm run test:devcontainer:e2e` | Manual Docker/local-registry E2E for devcontainer image builds |
| `npm run test:container-as-worker:e2e` | Manual Docker + Temporal E2E for launch -> claim -> execute -> exit container-worker behavior |

## Tiers

| Tier | Tool | Location | Notes |
|---|---|---|---|
| Unit | Vitest | `server/tests/**/*.test.ts` outside `integration/`, plus `tests/*.test.ts` | Pure functions and small module contracts |
| Server integration | Vitest + Supertest | `server/tests/integration/health.test.ts`, `server/tests/integration/errorHandler.test.ts`, `server/tests/integration/linear.test.ts` | Hits real app/client code with external APIs stubbed at the boundary |
| Workflow integration | Temporal + Vitest | `server/tests/integration/temporal.*.test.ts`, `linear-target-repo-resolution.test.ts`, `container-lifecycle.test.ts` | Requires real Temporal on `localhost:7233`; tests create their own workers |
| Manual E2E | Docker + Temporal + scripts | `npm run test:devcontainer:e2e`, `npm run test:container-as-worker:e2e` | Run when changing image build, launcher, or real container-worker lifecycle behavior |

There is no user-facing frontend E2E tier. Human-visible behavior runs through Linear, GitHub, and Slack, covered by integration tests that stub those APIs at the HTTP boundary.

## Temporal rules

- Workflow tests must run against real Temporal, not mocks. Workflow run state lives there.
- Start Temporal with `docker compose up -d temporal temporal-ui` before running the full suite if it is not already up.
- Workflow tests create their own workers. Do not start `npm run --prefix server temporal:worker` just for tests.
- If the app worker is already running on the default `the-furnace` task queue, stop it or run tests with a unique `TEMPORAL_TASK_QUEUE`.

## Environment variables

- `TEMPORAL_TASK_QUEUE` — override default queue name (`the-furnace`) for isolated workflow runs.
- `TEMPORAL_ADDRESS` — Temporal frontend address; defaults to `localhost:7233`.
- `TEMPORAL_NAMESPACE` — Temporal namespace; defaults to `default`.
- `TEMPORAL_LINEAR_POLLER_EVERY` — override linear poller schedule interval (default `1m`).
- `LINEAR_API_KEY` — required for Linear client initialization.
- `LINEAR_TEAM_ID` — required team context for Linear ticket queries/mutations.
- `LINEAR_STATE_ID_IN_PROGRESS` — target Linear workflow state id for ticket start transitions.
- `LINEAR_STATE_ID_DONE` — target Linear workflow state id for successful terminal transitions.
- `LINEAR_STATE_ID_CANCELED` — target Linear workflow state id for cancel terminal transitions.
- `.env.test` (gitignored) — test-only overrides.
- `DEVCONTAINER_REGISTRY_URL` — registry namespace for pre-warmed devcontainer images.
- `DEVCONTAINER_REGISTRY_TOKEN` — registry write/pull token for devcontainer image builds.
- `TARGET_REPO_GITHUB_TOKEN` — read-only GitHub token used to resolve refs and clone tracked target repos.
- `CLAUDE_CODE_OAUTH_TOKEN` — optional Claude OAuth token for worker containers, generated via `claude setup-token`. Put it in `server/.env`; the `dev`/`start`/`temporal:worker` npm scripts auto-load it via `tsx --env-file=.env`, and the launcher forwards it into containers.
- `ANTHROPIC_API_KEY` — optional Claude API key for worker containers. Same `server/.env` flow as `CLAUDE_CODE_OAUTH_TOKEN`.
- `CONTAINER_TEMPORAL_ADDRESS` — Temporal address passed to Docker-launched worker containers in container-worker E2E; on macOS/Windows Docker Desktop use `host.docker.internal:7233`.

## Adding a new test

1. Place server unit tests alongside the code under `server/tests/` mirroring the `server/src/` tree.
2. Place root tooling tests, such as build-script tests, under `tests/`.
3. Integration tests go in `server/tests/integration/` and import the app factory from `server/src/app.ts`.
4. For workflow tests, start local Temporal services first with `docker compose up -d temporal temporal-ui`.

## What NOT to mock

- Temporal for workflow tests.
- The app factory; use it directly via Supertest.
- Claude Agent SDK calls in agent-activity integration tests. Use SDK replay fixtures if available, or skip those tests in CI rather than faking SDK responses.
