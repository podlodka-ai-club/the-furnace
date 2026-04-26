# the-furnace

Autonomous coding agent system orchestrated via Temporal workflows. Linear tickets -> failing tests (spec agent) -> green tests (coder agent) -> single reviewer verdict -> open PR.

See [`openspec/concept.md`](openspec/concept.md) for the full concept and [`openspec/roadmap.md`](openspec/roadmap.md) for the phased implementation plan.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + TypeScript (ESM) |
| Orchestration | Temporal (added in `temporal-setup`) |
| Agent framework | Claude Agent SDK (added with `spec-agent`/`coder-agent`) |
| Database | PGLite for dev/test, PostgreSQL for prod |
| Tests | Vitest (unit + Supertest integration) |
| External integrations | Linear, GitHub, Slack |

## Getting started

```bash
# Install workspace dependencies
npm install
cd server && npm install && cd ..

# Configure local env (required for Linear integration)
cp server/.env.example server/.env

# Required values in server/.env
LINEAR_API_KEY=lin_api_xxx
LINEAR_TEAM_ID=team_xxx
LINEAR_STATE_ID_IN_PROGRESS=state_xxx
LINEAR_STATE_ID_DONE=state_xxx
LINEAR_STATE_ID_CANCELED=state_xxx

# Optional poll cadence override (default: 1m)
TEMPORAL_LINEAR_POLLER_EVERY=1m

# Start the dev server (tsx watch)
npm run dev

# Start local Temporal + UI (required for Temporal smoke tests)
docker compose up -d temporal temporal-ui

# Start Temporal worker in a second terminal
npm run --prefix server temporal:worker

# Run tests
npm test
```

Dev server listens on port 3000. The `/health` endpoint is the first thing to land (see the `foundation` change).
Temporal frontend is available at `localhost:7233` (gRPC API for SDK/client/worker traffic; not a browser page).
Temporal UI is available at `http://localhost:8233` (human web interface).

When the worker boots, it ensures a recurring Temporal schedule exists for `linearPollerWorkflow` so `agent-ready` + `Todo` Linear tickets are polled automatically (default every 1 minute).

Per-ticket workflow state sync to Linear uses a Temporal activity with retry policy: initial interval `1s`, backoff `2x`, maximum interval `30s`, and maximum attempts `5`. If retries are exhausted, the workflow transition fails and remains visible for operator intervention.

## Spec-driven workflow

Work is scoped as **changes** under `openspec/changes/<name>/`. Each change has a `proposal.md` describing why, what, and impact. Specs, design, and tasks are created during implementation via the OpenSpec `/opsx:*` slash commands.

```bash
# See all changes and their status
openspec list

# Start working on the first change
openspec show foundation
```

## Project structure

```
the-furnace/
├── server/              # Node backend (Express + Temporal worker)
│   ├── src/
│   └── tests/
├── data/pglite/         # PGLite dev database (gitignored)
├── openspec/
│   ├── concept.md       # Full design concept
│   ├── roadmap.md       # Phased change list
│   └── changes/         # One directory per change with proposal.md
├── CLAUDE.md            # Agent instructions
├── AGENTS.md            # AI agent conventions
└── TESTING.md           # Test strategy and commands
```

## Learn more

- [`openspec/concept.md`](openspec/concept.md) — full architecture and principles
- [`openspec/roadmap.md`](openspec/roadmap.md) — implementation order
- [`CLAUDE.md`](CLAUDE.md) — how to work in this repo with Claude
- [`TESTING.md`](TESTING.md) — test tiers and commands
