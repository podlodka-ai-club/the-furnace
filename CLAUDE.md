# the-furnace

Autonomous coding agent system orchestrated via Temporal workflows. Linear ticket → failing tests (spec agent) → green tests (coder agent) → multi-persona review → auto-merge.

## Spec-driven workflow

This project uses OpenSpec. Work is scoped as **changes** under `openspec/changes/<name>/`. Before implementing a change, read its `proposal.md`. New work starts with a proposal, then gets specs/tasks through the opsx workflow (`/opsx:new`, `/opsx:ff`, `/opsx:apply`).

- Roadmap: `openspec/roadmap.md`
- Concept: `openspec/concept.md`
- Active changes: `openspec status`

## Stack

- Runtime: Node.js + TypeScript (ES modules)
- Orchestration: Temporal (added in `temporal-setup` change)
- Agent framework: Claude Agent SDK (added in `spec-agent` / `coder-agent` changes)
- Database: PGLite for dev/test, PostgreSQL for production. Never require a running Postgres for local dev.
- Tests: Vitest (unit + integration via Supertest)

## Conventions

- Strict TypeScript. No `any` unless justified in a comment.
- Integration tests hit PGLite directly, not mocks.
- Commits reference the OpenSpec change they belong to.
- Don't add dependencies outside of a change proposal that approves them.

## Linear → workflow path

Tickets must carry both an `agent-ready` label and exactly one `repo:<slug>` label whose `<slug>` matches an entry in `build/repos.json`. The Linear client (`server/src/linear/client.ts`) resolves the slug at the polling boundary and returns `ResolvedTicket[]`; tickets without a valid repo label are logged (`event: "linear.ticket_skipped"`) and skipped before any workflow starts.
