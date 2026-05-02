# Testing

## Quick reference

| Command | What it runs |
|---|---|
| `npm test` | Server unit + integration tests, then root devcontainer build-script tests (Vitest) |
| `TEMPORAL_TASK_QUEUE=local-test npm test` | Same full suite, isolated from any already-running app worker on the default queue |
| `cd server && npx vitest` | Watch mode from the server package |
| `cd server && npx vitest run tests/integration` | Just integration tests |
| `npm run build:devcontainer -- --repo <slug>` | Registry-backed devcontainer image build for one tracked repo |
| `npm run test:devcontainer:e2e` | Local registry E2E for the demo devcontainer image |
| `docker compose up -d temporal temporal-ui` | Starts local Temporal services for smoke workflow tests |

## Tiers

| Tier | Tool | Location | Notes |
|---|---|---|---|
| Unit | Vitest | `server/tests/*.test.ts`, `tests/*.test.ts` | Pure-function coverage, no I/O |
| Integration | Vitest + Supertest | `server/tests/integration/*.test.ts` | Hits the Express app factory + PGLite directly |
| Workflow | Temporal + Vitest | `server/tests/integration/temporal.*.test.ts` | Requires local Temporal services on `localhost:7233` |

There is no end-to-end test tier — this project has no user-facing frontend. Human-visible behavior runs through Linear, GitHub, and Slack, all covered by integration tests that stub those APIs at the HTTP layer.

Workflow tests create their own Temporal workers. Do not start `npm run --prefix server temporal:worker` just to run tests. If the app worker is already running on the default `the-furnace` task queue, stop it or set `TEMPORAL_TASK_QUEUE` to a unique value for the test command; otherwise the app worker can consume test workflow tasks with production activities.

## Database strategy

- **Dev and tests** use PGLite with a disposable data directory per test file (`data/pglite/<test-id>/`).
- **Production** uses PostgreSQL via `$DATABASE_URL`.
- All SQL is PostgreSQL-compatible; PGLite-only features are forbidden.
- **Integration tests must hit PGLite, not mocks** — this is load-bearing per the concept: mock/prod divergence is exactly the failure class the architecture exists to eliminate.

## Environment variables for isolation

- `PGLITE_DATA_DIR` — override the default `data/pglite/` path during tests.
- `TEMPORAL_TASK_QUEUE` — override default queue name (`the-furnace`) for isolated workflow runs.
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
- `CLAUDE_CODE_OAUTH_TOKEN` — optional Claude OAuth token for worker containers, generated via `claude setup-token`. Authenticates against the operator's Claude Pro/Max subscription. Put it in `server/.env` (already gitignored); the `dev`/`start`/`temporal:worker` npm scripts auto-load it via `tsx --env-file=.env` and the launcher forwards it into containers. Do NOT export the token in your shell unless you are running an integration runner that does not pass through `--env-file`.
- `ANTHROPIC_API_KEY` — optional Claude API key for worker containers (metered API billing alternative to `CLAUDE_CODE_OAUTH_TOKEN`). Same `server/.env` flow; same shell-export caveat. Local integration tests under `server/tests/integration/` reuse the same `.env` flow when launching workers, regardless of which auth env var is in use.

## Adding a new test

1. Place server unit tests alongside the code under `server/tests/` mirroring the `server/src/` tree.
2. Place root tooling tests, such as build-script tests, under `tests/`.
3. Integration tests go in `server/tests/integration/` and import the app factory from `server/src/app.ts`.
4. For workflow tests, start local Temporal services first with `docker compose up -d temporal temporal-ui`.

## What NOT to mock

- PGLite (use a real ephemeral instance per test file).
- The app factory (use it directly via Supertest).
- Claude Agent SDK calls in agent-activity integration tests — use SDK replay fixtures if available, or skip those tests in CI rather than faking SDK responses.
