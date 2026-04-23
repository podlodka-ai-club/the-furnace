# AGENTS.md

Instructions for AI coding agents working in this repo.

## Before making changes

1. Read `openspec/roadmap.md` to see phase ordering.
2. Read the relevant `openspec/changes/<name>/proposal.md` before touching code for that change.
3. If the work doesn't fit an existing change, open a new one via `/opsx:new` instead of ad-hoc edits.

## Implementation rules

- Follow the proposal's `What Changes` and `Capabilities` sections — do not expand scope.
- Run `npm test` from the repo root before declaring work complete.
- Integration tests must hit PGLite (the dev/test database), not mocks.
- Never modify `openspec/concept.md`; amend `proposal.md` if scope shifts.

## Provenance

Commits should reference the change name in the message (e.g. `feat(spec-agent): ...`). Commit trailers with workflow metadata are added by the `provenance-store` change once implemented.
