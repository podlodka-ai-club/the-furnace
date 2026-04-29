# the-furnace — Implementation Roadmap

> Track progress through the changes. Each change is implemented in order.
> After completing a change, mark it done and start the next one.

---

## Phase 1: Foundation

- [x] `foundation` — Project structure, dev tooling, health check endpoint
- [x] `data-model` — PGLite schema and migrations for workflow runs, tickets, attempts, reviews

> **Milestone:** `npm run dev` starts a TypeScript server; `/health` returns 200; database tables exist.

## Phase 2: Temporal orchestration

- [x] `temporal-setup` — Temporal client/worker bootstrap, local docker-compose, activity-level rate limiting for Claude SDK calls
- [x] `linear-integration` — Linear API client: read `agent-ready` tickets, create typed clarification sub-tickets
- [x] `agent-io-contracts` — Zod schemas and inferred TS types for inter-agent boundaries (spec/coder/review outputs), validated at phase-activity borders
- [x] `per-ticket-workflow` — Cron workflow polling Linear; per-ticket Temporal workflow with spec → code → review phases (as no-op activities initially)
- [x] `ticket-state-sync` — Sync Linear ticket state (`In Progress`/`Done`/`Canceled`) from per-ticket workflow lifecycle

> **Milestone:** Cron picks up an `agent-ready` ticket, spawns a workflow, and runs through three no-op phases durably.

## Phase 3: Container runtime

- [x] `devcontainer-images` — Pre-warmed per-repo devcontainer images using the repo's existing `devcontainer.json`, with repo cloned and deps installed
- [x] `container-as-worker` — Container boots, registers as a Temporal worker with capability metadata, claims a matching task, dies on completion

> **Milestone:** A per-ticket workflow dispatches to an ephemeral container that runs a no-op activity and terminates cleanly.

## Phase 4: Agent pipeline (MVP)

- [x] `spec-agent` — Linear ticket → failing tests inside the container; opens a typed `ac-clarification` sub-ticket when AC is ambiguous
- [ ] `coder-agent` — Claude Agent SDK loop targeting green tests; files typed `dep-missing` / `design-question` sub-tickets when stuck
- [ ] `review-agent` — Single reviewer activity with one verdict and reasoning payload over the coder diff
- [ ] `github-adapter` — Open PR after review passes; attach structured workflow trailers for traceability

> **Milestone:** End-to-end run against a curated demo ticket produces a PR and completes the workflow without human handoff.

## Phase 5: Provenance

- [ ] `provenance-store` — Content-addressed tool-output storage keyed to workflow metadata

> **Milestone:** Every agent/tool output in the MVP pipeline is content-addressed and queryable by workflow.

## Phase 6: Advanced review and notifications

- [ ] `persona-reviewers` — Four reviewer personas with independent contexts: security hawk, perf paranoid, grumpy architect, naming & patterns
- [ ] `vote-aggregator` — Unanimous pass → auto-merge queue with veto window; split vote → human tiebreaker in Linear with per-persona reasoning
- [ ] `slack-notifications` — Veto window alerts on auto-merge candidates; human tiebreaker notifications for split votes

## Phase 7: Chores

- [ ] `server-unused` — Project was created from classic web-api templates, therefore have server runned by server/index.ts that is only launching migrations and hosts /health endpoint. We should probably get rid of it

> **Milestone:** Advanced governance complete — multi-persona review, split-vote escalation, and Slack-driven veto signaling.
