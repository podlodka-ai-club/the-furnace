## Why

Today the spec agent's `request_ac_clarification` path opens a Linear sub-ticket and throws `AcClarificationRequested` non-retryably. The per-ticket workflow ends in a *failed* terminal state, and the Linear poller eventually re-discovers the parent ticket (after a human edits it back to `agent-ready`) and starts a brand new workflow run via `WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY`. That round-trip throws away in-memory context (attempt counts, prior failures), forces the operator to edit the parent ticket to "unstick" it, and offers no operator-driven resume path other than going back through Linear.

Temporal already has a first-class primitive for this exact shape — workflows that wait for human input. Switching to a signal lets the per-ticket workflow keep running, lets operators answer clarifications directly from the Temporal Web UI, and removes the fail-and-restart workaround.

## What Changes

- The spec activity, when the agent calls `request_ac_clarification`, SHALL still open the Linear sub-ticket as the human-readable record of the question, but SHALL return a structured "needs clarification" result (an `AwaitingClarification` discriminated union member) instead of throwing `AcClarificationRequested`.
- The per-ticket workflow SHALL define a new `clarificationAnswer` signal carrying `{ answer: string; resolvedBy?: string }` (operator name optional).
- After receiving the "needs clarification" result, the workflow SHALL call `await condition(() => clarificationAnswer !== undefined || cancelled)` to wait, then re-dispatch the spec phase with the answer threaded into the prompt.
- The workflow SHALL expose a `currentClarification` query returning `{ subTicketRef, questions, reason } | undefined` so operators can see *what* they're answering from the UI.
- When a clarification is answered, the workflow SHALL post the answer back as a Linear comment on the sub-ticket and mark it Done so the Linear paper trail stays consistent with the workflow state.
- **BREAKING (internal contract)**: `runSpecPhase` activity output type changes from `SpecPhaseOutput` to a discriminated union `SpecPhaseResult = SpecPhaseOutput | AwaitingClarification`. Workflow code branches on `kind`. The `AcClarificationRequested` failure type is removed from `SPEC_FAILURE_TYPES` and from `stuckFailureTypes` in `runSpecPhaseWithRecording`.
- The Linear poller's reliance on `ALLOW_DUPLICATE_FAILED_ONLY` to recover stuck workflows SHALL still hold for non-clarification failures (review-cap exhaustion, infra failures); only the clarification path moves to signals.
- Scope for this change is **spec phase only**. The coder phase's `dep-missing` and `design-question` stuck failures use the same pattern and can be migrated in a follow-up change once the signal pattern is validated.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `spec-generation`: replace "AC Clarification Opens Sub-Ticket and Fails Non-Retryably" requirement with one that opens the sub-ticket and returns an awaiting-clarification result; activity contract output type changes.
- `ticket-workflow`: replace "AC Clarification Failure Pauses Workflow Pending Human" requirement with one describing the signal-and-wait flow; add requirements for the `clarificationAnswer` signal, the `currentClarification` query, and the post-answer comment-and-close-sub-ticket behavior.

## Impact

- **Code**: [server/src/agents/spec/activity.ts](server/src/agents/spec/activity.ts), [server/src/agents/spec/agent.ts](server/src/agents/spec/agent.ts), [server/src/agents/contracts/spec-output.ts](server/src/agents/contracts/spec-output.ts), [server/src/temporal/workflows/per-ticket.ts](server/src/temporal/workflows/per-ticket.ts), [server/src/agents/spec/prompt.md](server/src/agents/spec/prompt.md) (clarify human-resume language), Linear client (add a `commentOnTicket` + `closeTicket` capability if not already present, used to resolve the sub-ticket).
- **Tests**: [server/tests/agents/spec/activity.test.ts](server/tests/agents/spec/activity.test.ts) and [server/tests/integration/temporal.ticketWorkflows.test.ts](server/tests/integration/temporal.ticketWorkflows.test.ts) need updates for the new contract; new integration test asserting that a signal resumes the workflow.
- **Operator workflow**: clarifications now answerable from Temporal Web UI (Signal button) *or* by closing the Linear sub-ticket (poller-style fallback can come later). For this change, Temporal-UI-driven resume is the canonical path; Linear sub-ticket exists as the human-readable record only.
- **Dependencies**: none added.
- **Backwards compatibility**: in-flight workflows on the old contract will continue to fail with `AcClarificationRequested` until completed/restarted; the new contract applies to workflows started after deploy. Document in tasks.md.
