# the-furnace — Implementation Roadmap

> Track progress through the changes. Each change is implemented in order.
> After completing a change, mark it done and start the next one.

---

## Phase 1: Foundation

- [ ] `foundation` — Project structure, dev tooling, health check endpoint
- [ ] `data-model` — PGLite schema and migrations for workflow runs, tickets, attempts, reviews

> **Milestone:** `npm run dev` starts a TypeScript server; `/health` returns 200; database tables exist.

## Phase 2: Temporal orchestration

- [ ] `temporal-setup` — Temporal client/worker bootstrap, local docker-compose, activity-level rate limiting for Claude SDK calls
- [ ] `linear-integration` — Linear API client: read `agent-ready` tickets, create typed clarification sub-tickets
- [ ] `per-ticket-workflow` — Cron workflow polling Linear; per-ticket Temporal workflow with spec → code → review phases (as no-op activities initially)

> **Milestone:** Cron picks up an `agent-ready` ticket, spawns a workflow, and runs through three no-op phases durably.

## Phase 3: Container runtime

- [ ] `devcontainer-images` — Pre-warmed per-repo devcontainer images using the repo's existing `devcontainer.json`, with repo cloned and deps installed
- [ ] `container-as-worker` — Container boots, registers as a Temporal worker with capability metadata, claims a matching task, dies on completion

> **Milestone:** A per-ticket workflow dispatches to an ephemeral container that runs a no-op activity and terminates cleanly.

## Phase 4: Agent pipeline

- [ ] `spec-agent` — Linear ticket → failing tests inside the container; opens a typed `ac-clarification` sub-ticket when AC is ambiguous
- [ ] `coder-agent` — Claude Agent SDK loop targeting green tests; files typed `dep-missing` / `design-question` sub-tickets when stuck
- [ ] `persona-reviewers` — Four reviewer personas with independent contexts: security hawk, perf paranoid, grumpy architect, naming & patterns
- [ ] `vote-aggregator` — Unanimous pass → auto-merge queue with veto window; split vote → human tiebreaker in Linear with per-persona reasoning

> **Milestone:** End-to-end run against a curated demo ticket produces a mergeable PR awaiting the veto window.

## Phase 5: Integrations & provenance

- [ ] `github-adapter` — PR creation, structured commit trailers (workflow-id, model, ticket, attempt-count), auto-merge after veto window closes
- [ ] `slack-notifications` — Veto window alerts on auto-merge candidates; human tiebreaker notifications for split votes
- [ ] `provenance-store` — Content-addressed tool-output storage keyed to workflow metadata

> **Milestone:** MVP complete — Linear ticket to merged PR with full provenance and human escalation paths.
