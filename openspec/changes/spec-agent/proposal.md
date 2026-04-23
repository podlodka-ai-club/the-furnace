## Why

Concept §3.4: separating specification from implementation into two reasoning passes — with tests as the hard artifact interface — prevents the coder from tuning tests to its own output. If the spec agent cannot translate a ticket into tests, that is itself a first-class signal that the ticket is ambiguous.

## What Changes

- Add `@anthropic-ai/claude-agent-sdk` dependency.
- Replace the `runSpecPhase` no-op with a real activity that:
  1. Reads the Linear ticket from the `tickets` table.
  2. Invokes the Claude Agent SDK inside the container with a spec-focused prompt (`server/src/agents/spec/prompt.md`).
  3. Produces a failing test commit on a feature branch (one commit per test file).
  4. If the model cannot produce tests because acceptance criteria are ambiguous, instead opens an `ac-clarification` sub-ticket via `linear-integration` with a deep link back to the workflow moment, and the activity fails with a non-retryable error that the workflow interprets as "pause pending human".
- Write an `attempts` row on every iteration (outcome: `tests-written` | `clarification-requested`).

## Capabilities

### New Capabilities

- `spec-generation`: Ticket → failing tests (on a feature branch), with structured ambiguity detection that opens a typed clarification sub-ticket instead of guessing.

### Modified Capabilities

- `ticket-workflow`: `runSpecPhase` now returns a branch + test-commit manifest used by the coder phase, or signals a human-pause state.

## Impact

- New dep: `@anthropic-ai/claude-agent-sdk`.
- New files: `server/src/agents/spec/activity.ts`, `server/src/agents/spec/prompt.md`.
- Depends on: `container-as-worker` (execution substrate), `linear-integration` (sub-ticket creation), `data-model` (`attempts` table).
- Runs inside the ephemeral container — no host-side execution.
