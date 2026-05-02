Autonomous coding agent system orchestrated via Temporal workflows. Linear ticket → failing tests (spec agent) → green tests (coder agent) → multi-persona review → auto-merge.

## Spec-driven workflow

This project uses OpenSpec. Work is scoped as **changes** under `openspec/changes/<name>/`. Before implementing a change, read its `proposal.md`. New work starts with a proposal, then gets specs/tasks through the opsx workflow (`/opsx:new`, `/opsx:ff`, `/opsx:apply`).

- Roadmap: `openspec/roadmap.md`
- Concept: `openspec/concept.md`
- Active changes: `openspec status`

## Before making changes

1. Read `openspec/roadmap.md` to see phase ordering.
2. Read the relevant `openspec/changes/<name>/proposal.md` before touching code for that change.
3. If the work doesn't fit an existing change, open a new one via `/opsx:new` instead of ad-hoc edits.

## Implementation rules

- Follow the proposal's `What Changes` and `Capabilities` sections — do not expand scope.
- Run tests how described in `TESTING.md` from the repo root before declaring work complete.
- Integration tests must run against real Temporal (workflow run state lives there), not mocks.
- Never modify `openspec/concept.md`; amend `proposal.md` if scope shifts.

## Conventions

- Strict TypeScript. No `any` unless justified in a comment.
- Integration tests run against real Temporal, not mocks.
- Commits reference the OpenSpec change they belong to.
- Don't add dependencies outside of a change proposal that approves them.
