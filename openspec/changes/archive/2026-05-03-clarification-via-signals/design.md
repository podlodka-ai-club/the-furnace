## Context

The spec phase activity uses non-retryable failures as a *control flow* signal: throwing `AcClarificationRequested` from inside the activity body causes the workflow to terminate in `failed` state with structured detail, which is the project's current way of pausing for human input. The workflow defines `stuckFailureTypes` to skip its retry loop when one of these failure types appears, and the Linear poller relies on `WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY` to start a *new* per-ticket workflow run when the same ticket reappears in `agent-ready` state.

This works, but it's a workaround for the more natural primitive: a workflow that waits. Temporal signals are exactly that — durable, replay-safe, queue-on-no-listener. They also have first-class Web UI support: any operator can open a workflow run, click "Signal", paste a JSON payload, and resume the workflow.

The same pattern is used twice more in the coder phase (`DepMissingRequested`, `DesignQuestionRequested`). Migrating all three at once would be a bigger blast radius, so this change validates the pattern on the spec phase only.

## Goals / Non-Goals

**Goals:**

- Replace the spec phase's fail-and-restart clarification flow with a wait-on-signal flow, while keeping the Linear sub-ticket as the human-readable record of the question.
- Allow operators to resume a clarification-blocked workflow from Temporal Web UI by sending a signal.
- Keep the workflow's `cancel` semantics intact while waiting (a cancel during clarification should still terminate cleanly).
- Make the clarification questions visible via a Temporal query so operators see *what* they're answering before signaling.
- Keep the spec activity short-lived (the wait happens in the workflow, not in the activity, so we don't burn the activity heartbeat budget).

**Non-Goals:**

- Migrating the coder phase's `dep-missing` / `design-question` paths to signals — follow-up change.
- Removing the Linear sub-ticket entirely. The sub-ticket remains as the human-readable record and as a fallback channel; we may add Linear-driven resume in a later change.
- Multi-round clarifications inside a single spec attempt. If the agent answers the operator's clarification with *another* clarification, the workflow simply waits again — same machinery, no extra design.
- Replacing the existing review-cap-exhaustion failure path or other non-clarification failures.
- Backwards compatibility for in-flight workflows started under the old contract. Those will run to their existing `AcClarificationRequested` failure and stop; operators will resume them by editing the parent ticket as today, then they're done with the legacy path.

## Decisions

### Decision 1: Signal lives on the workflow, wait happens in the workflow

The activity finishes quickly after opening the sub-ticket, returning a discriminated `AwaitingClarification` value. The workflow inspects the result, registers the question in workflow state, and `await condition(...)` until the signal arrives.

Rationale: Temporal activities have heartbeat-bounded lifetimes (here, 30 s) and live in containers that shut down after a single activity per the per-attempt-container contract. A long-lived activity that polls or blocks would fight both. Workflows, by contrast, can sleep indefinitely with zero cost — that's the whole point.

Alternative considered: have the activity itself signal a parent workflow and stay alive. Rejected because it inverts the per-attempt-container contract and complicates the signal-flow direction.

### Decision 2: Activity returns a discriminated union, doesn't throw

```ts
type SpecPhaseResult =
  | { kind: "done"; output: SpecPhaseOutput }
  | { kind: "awaiting_clarification"; subTicketRef: SubTicketRef; reason: string; questions: string[] };
```

The workflow code that consumes `runSpecPhase` switches on `kind` and either advances or enters the wait loop.

Rationale: throwing for a *successful* "we did our job, now we're paused" outcome muddles error semantics. A discriminated union makes the two paths first-class and statically checkable. It also frees us from `stuckFailureTypes` plumbing in `runPhase`.

Alternative considered: keep the throw, catch it in the workflow, parse the failure detail to extract the sub-ticket ref. Rejected — it's the current shape and the source of the awkwardness.

### Decision 3: Signal payload is `{ answer: string; resolvedBy?: string }`

The answer is a single freeform string. It's appended to a "Clarification answer" section on the spec agent's prompt for the next attempt. `resolvedBy` is optional metadata for audit (operator name or email; defaults to "operator" if omitted).

Rationale: structured Q&A pairs would be nicer but premature — the agent's questions are already a single block in the prompt and a single answer block is the symmetric shape. We can extend the schema later if multi-question structured answers prove useful.

### Decision 4: Re-dispatch the spec phase via the same `runPhase` machinery, not a new code path

After receiving the answer, the workflow re-enters the existing `runPhase("spec", ...)` loop. The spec activity is invoked again with an extended input that includes the prior question and the operator's answer; the prompt template gets a new `{{CLARIFICATION_HISTORY}}` block.

Rationale: keeps a single retry-on-fresh-container code path. The clarification round counts against `PHASE_MAX_ATTEMPTS` (3) — same as any other spec retry — to bound runaway loops where the agent keeps asking and getting answered.

### Decision 5: Sub-ticket auto-resolved on signal

When the workflow receives a clarification signal, it dispatches a small activity (`resolveClarificationSubTicket`) that comments the answer onto the Linear sub-ticket and transitions it to `Done`. This keeps Linear consistent with workflow state without requiring the operator to also touch Linear.

Rationale: sub-ticket exists for human-readability; if the operator answered via Temporal UI, Linear shouldn't lie about state. The activity is best-effort retryable; if Linear is down, the workflow logs and continues — the workflow's truth is the signal, not the sub-ticket.

Alternative considered: leave sub-ticket open; require operators to close it manually. Rejected — too easy for state to drift.

### Decision 6: `currentClarification` query

A new query handler exposes `{ subTicketRef, reason, questions, askedAt } | undefined` so an operator opening the workflow in Temporal UI can see what's being asked without cross-referencing Linear. Cleared back to `undefined` once the signal is received.

### Decision 7: Cancel during wait

The wait condition is `() => clarificationAnswer !== undefined || cancelled`. If cancel arrives first, the workflow runs the same `transitionToCancelled` it does elsewhere — clarification state is dropped, no signal is awaited.

### Decision 8: Workflow-id reuse policy unchanged

The poller still uses `ALLOW_DUPLICATE_FAILED_ONLY`. Clarifications no longer cause failed terminations, so they no longer rely on it; non-clarification failures (e.g. round-cap exhaustion) still do. No change.

## Risks / Trade-offs

- **Risk**: Workflow runs sit indefinitely waiting for a signal that may never come (operator forgets, leaves company, etc.).
  → **Mitigation**: out of scope for this change, but the wait condition can be wrapped in a workflow-level timeout in a follow-up. Document in tasks/proposal that no timeout exists yet.

- **Risk**: Operators send malformed signal payloads from the Temporal UI (wrong JSON shape).
  → **Mitigation**: signal handler validates with Zod and rejects on parse failure (the workflow stays waiting, ready to receive a corrected signal). The query response includes the expected payload shape so the operator can copy-paste a template.

- **Risk**: Two operators race to answer (one via signal, one by closing the Linear sub-ticket).
  → **Mitigation**: Linear-side resume is *not* implemented in this change. Sub-ticket exists as a record only; the workflow only acts on the signal.

- **Risk**: Migration boundary — workflows started under the old contract are still in flight.
  → **Mitigation**: those workflows have already failed with `AcClarificationRequested` (the prior contract) before this code is deployed; they'll be picked back up by the poller as today. Workflows started post-deploy use the new contract. No mid-flight migration.

- **Trade-off**: The Linear sub-ticket becomes a *record* and not the *blocker*. This is a small loss of "Linear is single source of truth" — operators must look at Temporal UI for the actual blocked-on-clarification state. Acceptable because operators already use Temporal UI for cancel signals and queries; this just adds another reason.

- **Trade-off**: Removing `AcClarificationRequested` from the failure-type vocabulary means dashboards or alerts keying on that string need to be updated. There are none today (audit confirms only test fixtures and the workflow's stuck-types list reference it), so the blast radius is contained.

## Migration Plan

1. Land contract changes first (discriminated union output, signal/query types) without changing behavior.
2. Wire signal handler and wait loop in the workflow.
3. Update spec activity to return the new union.
4. Delete `AcClarificationRequested` from `SPEC_FAILURE_TYPES` and `stuckFailureTypes`.
5. Update tests and integration tests in lockstep.
6. Deploy. Drain in-flight legacy-contract workflows naturally.

Rollback: revert the workflow + activity diff together. The Linear sub-ticket creation is unchanged, so rolling back doesn't strand any data.

## Open Questions

- Do we want a default workflow-level timeout for the wait (e.g. 7 days → auto-fail with a `ClarificationTimeout` failure)? Deferred — no timeout for now, easy to add later.
- Should the signal be exposed under a more general name (e.g. `humanInput`) so the same machinery serves coder dep-missing/design-question without renaming? Defer until the coder migration; can add an alias signal then.
