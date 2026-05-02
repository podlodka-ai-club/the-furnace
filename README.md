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

# Start local Temporal + UI (required for workflow tests)
docker compose up -d temporal temporal-ui

# Run the full test suite.
# Use an isolated task queue if a local Temporal worker is already running.
TEMPORAL_TASK_QUEUE=local-test npm test
```

Dev server listens on port 3000. The `/health` endpoint is the first thing to land (see the `foundation` change).
Temporal frontend is available at `localhost:7233` (gRPC API for SDK/client/worker traffic; not a browser page).
Temporal UI is available at `http://localhost:8233` (human web interface).

`npm test` runs the server Vitest suite first, then root devcontainer build-script tests. The workflow tests create their own Temporal workers, so you do not need to start `npm run --prefix server temporal:worker` for tests. If that long-running worker is already running on the default `the-furnace` task queue, either stop it or run tests with a unique `TEMPORAL_TASK_QUEUE` as shown above; otherwise it can pick up test workflow tasks and cause confusing failures.

For focused runs:

```bash
# Server tests only
npm run --prefix server test

# One test file
npm run --prefix server test -- tests/integration/linear.test.ts

# Vitest watch mode
cd server && npx vitest
```

When the app worker boots, it ensures a recurring Temporal schedule exists for `linearPollerWorkflow` so `agent-ready` + `Todo` Linear tickets are polled automatically (default every 1 minute).

Per-ticket workflow state sync to Linear uses a Temporal activity with retry policy: initial interval `1s`, backoff `2x`, maximum interval `30s`, and maximum attempts `5`. If retries are exhausted, the workflow transition fails and remains visible for operator intervention.

## Claude authentication

Worker containers need Claude credentials to run the Agent SDK. Three sources are supported, all checked at orchestrator startup; if none is viable the orchestrator exits non-zero with an error naming every option before any container launches.

1. `CLAUDE_CODE_OAUTH_TOKEN` (recommended on macOS for Pro/Max subscribers): generate once with `claude setup-token`, then add `CLAUDE_CODE_OAUTH_TOKEN=...` to `server/.env` (already gitignored). The token authenticates against your Claude subscription — same billing as `claude login`, no metered API charges — and works inside the container without needing the macOS Keychain. The npm `dev`/`start`/`temporal:worker` scripts auto-load it via `tsx --env-file=.env`, and the launcher forwards it via `docker run --env CLAUDE_CODE_OAUTH_TOKEN`.
2. `ANTHROPIC_API_KEY` (metered API billing): add `ANTHROPIC_API_KEY=sk-...` to `server/.env`. The launcher forwards it via `docker run --env ANTHROPIC_API_KEY`. Use this when you want explicit per-token billing or don't have a Claude subscription.
3. `~/.claude` bind-mount (Linux subscription auth): the launcher always read-only bind-mounts `~/.claude` (or `$CLAUDE_CREDS_DIR`) at `/root/.claude` inside the worker. On Linux this carries `claude login` subscription credentials. On macOS those credentials live in the Keychain, so the mount alone is not enough — use one of the env vars above.

Both env vars can be set at once; the Claude Agent SDK's own resolution order picks one. Neither needs to be exported in the host shell — `server/.env` is the canonical source.

The mount is retained regardless of which env var is set, because `~/.claude` also carries operator-level Claude settings, registered agents, and MCP server config that the SDK reads independently of how it authenticates.

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
# Build worker
npm run build:worker

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
