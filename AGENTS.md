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
- For code changes, run the applicable checks from `TESTING.md` before declaring work complete. The default full verification command is `TEMPORAL_TASK_QUEUE=local-test npm test` from the repo root.
- Documentation-only changes may skip code tests when no runtime files changed; say so explicitly in the final response.
- Workflow/integration tests must run against real Temporal (workflow run state lives there), not mocks.
- Never modify `openspec/concept.md`; amend `proposal.md` if scope shifts.

## Conventions

- Strict TypeScript. No `any` unless justified in a comment.
- Use npm scripts documented in `TESTING.md` for test runs; avoid ad-hoc `npx` commands unless debugging the tool itself.
- Commits reference the OpenSpec change they belong to.
- Don't add dependencies outside of a change proposal that approves them.

## Environment variables

- `TARGET_REPO_GITHUB_TOKEN` — GitHub PAT used both at devcontainer build time (clone target repos) and by the orchestrator worker for the GitHub PR-open activity. Minimum scope: `repo` for private repos, `public_repo` for public. Read lazily by the PR-open activity (worker boots without it; the activity throws a non-retryable failure when missing).
- `CLAUDE_MODEL` — optional; embedded in the PR-body metadata block (`Model:` line). Defaults to the literal `unknown` when unset.

## PR-body metadata contract

The PR-open activity emits a machine-parseable metadata block at the bottom of every PR body, delimited by HTML comments:

```
<!-- furnace:metadata -->
Workflow-Id: <temporal workflow id>
Ticket-Id: <linear issue id>
Ticket-Identifier: <FUR-123>
Attempt-Count: <integer>
Model: <claude-... or 'unknown'>
Final-Commit: <40-char SHA>
<!-- /furnace:metadata -->
```

Keys are emitted in this exact order. Future automation (vote-aggregator, auto-merge) parses against the delimiters; do not rename keys or change the block format without coordinating with downstream consumers.
