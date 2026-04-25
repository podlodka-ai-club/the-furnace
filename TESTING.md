# Testing

## Quick reference

| Command | What it runs |
|---|---|
| `npm test` | Server unit + integration tests (Vitest) |
| `cd server && npx vitest` | Watch mode from the server package |
| `cd server && npx vitest run tests/integration` | Just integration tests |
| `docker compose up -d temporal temporal-ui` | Starts local Temporal services for smoke workflow tests |

## Tiers

| Tier | Tool | Location | Notes |
|---|---|---|---|
| Unit | Vitest | `server/tests/*.test.ts` | Pure-function coverage, no I/O |
| Integration | Vitest + Supertest | `server/tests/integration/*.test.ts` | Hits the Express app factory + PGLite directly |
| Workflow | Temporal + Vitest | `server/tests/integration/temporal.*.test.ts` | Requires local Temporal services on `localhost:7233` |

There is no end-to-end test tier — this project has no user-facing frontend. Human-visible behavior runs through Linear, GitHub, and Slack, all covered by integration tests that stub those APIs at the HTTP layer.

## Database strategy

- **Dev and tests** use PGLite with a disposable data directory per test file (`data/pglite/<test-id>/`).
- **Production** uses PostgreSQL via `$DATABASE_URL`.
- All SQL is PostgreSQL-compatible; PGLite-only features are forbidden.
- **Integration tests must hit PGLite, not mocks** — this is load-bearing per the concept: mock/prod divergence is exactly the failure class the architecture exists to eliminate.

## Environment variables for isolation

- `PGLITE_DATA_DIR` — override the default `data/pglite/` path during tests.
- `TEMPORAL_TASK_QUEUE` — override default queue name (`the-furnace`) for isolated workflow runs.
- `LINEAR_API_KEY` — required for Linear client initialization.
- `LINEAR_TEAM_ID` — required team context for Linear ticket queries/mutations.
- `.env.test` (gitignored) — test-only overrides.

## Adding a new test

1. Place unit tests alongside the code under `server/tests/` mirroring the `server/src/` tree.
2. Integration tests go in `server/tests/integration/` and import the app factory from `server/src/app.ts`.
3. For workflow tests, start local Temporal services first with `docker compose up -d temporal temporal-ui`.

## What NOT to mock

- PGLite (use a real ephemeral instance per test file).
- The app factory (use it directly via Supertest).
- Claude Agent SDK calls in agent-activity integration tests — use SDK replay fixtures if available, or skip those tests in CI rather than faking SDK responses.
