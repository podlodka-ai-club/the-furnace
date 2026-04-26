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

Per-ticket workflow state sync to Linear uses a Temporal activity with retry policy: initial interval `1s`, backoff `2x`, maximum interval `30s`, and maximum attempts `5`. If retries are exhausted, the workflow transition fails and remains visible for operator intervention.

## Devcontainer image builds

`devcontainer-images` adds a per-target-repo image build pipeline. Tracked repos live in `build/repos.json`; each entry's `slug` must equal the normalized `<owner>-<name>` value.

Required environment variables:

```bash
DEVCONTAINER_REGISTRY_URL=ghcr.io/<owner-or-org>
DEVCONTAINER_REGISTRY_TOKEN=registry_write_token
TARGET_REPO_GITHUB_TOKEN=github_read_token_for_target_repos
```

Build commands:

```bash
# Build one repo at its current configured ref
npm run build:devcontainer -- --repo <repo-slug>

# Build one repo at an explicit commit
npm run build:devcontainer -- --repo <repo-slug> --sha <commit-sha>

# Run the local demo E2E against a local Docker registry
npm run test:devcontainer:e2e
```

Successful builds write `build/<repo-slug>/manifest.json` with the digest-pinned `imageRef` consumed by later runtime work. The alias tags `:sha-<commit>` and `:main` are for human discovery only. For MVP, image builds are intended to be run on demand when the Linear-driven orchestrator picks up a ticket and resolves the target repo/ref to an exact commit SHA.

The local E2E helper starts or reuses `furnace-local-registry-5001`, resolves the demo repo's current SHA, supplies local-only env defaults, builds the image, pulls it by digest, and runs a container smoke check. It writes a localhost manifest under `build/<repo-slug>/manifest.json`; treat that file as local test output.

The GitHub Actions workflow is a manual `workflow_dispatch` entry point for rebuilds and debugging. It commits generated manifest updates back to `main` with the default `GITHUB_TOKEN`. Repositories using protected `main` branches must allow GitHub Actions to push those generated manifest commits, or replace the commit-back step with a PR-opening flow before using the workflow.

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
