## 1. Contract types

- [x] 1.1 Add `specPhaseResultSchema` discriminated-union (`done` | `awaiting_clarification`) and `SpecPhaseResult` type in `server/src/agents/contracts/spec-output.ts`; export alongside the existing `SpecPhaseOutput`.
- [x] 1.2 Extend `specPhaseInputSchema` with optional `priorClarifications: Array<{ reason; questions; answer; resolvedBy? }>`.
- [x] 1.3 Add `clarificationAnswerSchema` (`{ answer: string; resolvedBy?: string }`) and `currentClarificationSchema` (`{ subTicketRef; reason; questions; askedAt } | undefined`) under a new shared module (e.g. `server/src/agents/contracts/clarification.ts`); export from the contracts barrel.

## 2. Spec activity

- [x] 2.1 Update `server/src/agents/spec/activity.ts` so `handleRequestAcClarification` returns `{ kind: "awaiting_clarification", subTicketRef, reason, questions }` instead of throwing `ApplicationFailure.nonRetryable(..., AcClarificationRequested, ...)`. Keep the Linear sub-ticket creation logic unchanged.
- [x] 2.2 Update the activity's main return path to wrap the existing successful output as `{ kind: "done", output }`.
- [x] 2.3 Remove `acClarificationRequested` from `SPEC_FAILURE_TYPES`.
- [x] 2.4 Render `priorClarifications` (when present) into the agent prompt under a `## Prior clarifications` section; update `renderPrompt` and the prompt template (add a token like `{{CLARIFICATION_HISTORY}}`).
- [x] 2.5 Validate the activity's return value against `specPhaseResultSchema` before returning.

## 3. Spec prompt copy

- [x] 3.1 Update `server/src/agents/spec/prompt.md` so the `request_ac_clarification` description says the workflow will pause for an operator signal (Temporal UI) rather than a Linear sub-ticket close.
- [x] 3.2 Add the `{{CLARIFICATION_HISTORY}}` placeholder to the prompt template (rendered to empty string when no prior clarifications).

## 4. Linear client

- [x] 4.1 Verify `linearClient` already supports commenting and transitioning a sub-ticket to `Done`; if not, add a minimal `commentAndCloseSubTicket(subTicketId, body)` method.
- [x] 4.2 Add a new activity `resolveClarificationSubTicketActivity` in `server/src/temporal/activities/linear.ts` (or co-located) that calls the client method.

## 5. Per-ticket workflow

- [x] 5.1 In `server/src/temporal/workflows/per-ticket.ts`, define `clarificationAnswerSignal = defineSignal<[ClarificationAnswer]>("clarificationAnswer")` and `currentClarificationQuery = defineQuery<CurrentClarification | undefined>("currentClarification")`.
- [x] 5.2 Add workflow-local state for `pendingClarification` (the asked payload) and `clarificationAnswer` (the received answer) plus `priorClarifications` history.
- [x] 5.3 Set the signal handler to validate the payload via Zod and store the answer; ignore malformed payloads. Set the query handler to return `pendingClarification`.
- [x] 5.4 Replace `runSpecPhaseWithRecording` so it loops: invoke `runSpecPhase({ ticket, priorClarifications })`, branch on `kind`. On `awaiting_clarification`: store `pendingClarification`, `await condition(() => clarificationAnswer !== undefined || cancelled)`, on cancel call `transitionToCancelled`, on answer call `resolveClarificationSubTicketActivity` (best-effort) then append to `priorClarifications`, clear pending/answer, and re-loop. On `done`: return the `SpecPhaseOutput`.
- [x] 5.5 Remove `SPEC_AC_CLARIFICATION_FAILURE_TYPE`, drop `stuckFailureTypes: [...]` from the spec runPhase call, and remove the constant from imports/usages.
- [x] 5.6 Wire the new query into the existing `setHandler(...)` block alongside `currentPhase`, `attemptCount`, `currentRound`.

## 6. Tests

- [x] 6.1 Update `server/tests/agents/spec/activity.test.ts`: replace assertions that `request_ac_clarification` throws `AcClarificationRequested` with assertions that it returns `{ kind: "awaiting_clarification", ... }`. Keep the Linear-outage test (still throws retryable).
- [x] 6.2 Update `server/tests/integration/temporal.ticketWorkflows.test.ts`: replace the `AcClarificationRequested` failure-path test with a happy-path-with-signal test that:
  - starts a workflow,
  - mocks the spec activity to return `kind: "awaiting_clarification"` first, then `kind: "done"` on second call,
  - waits for `currentClarification` to populate,
  - sends `clarificationAnswerSignal` from the test client,
  - asserts the spec activity is re-invoked with `priorClarifications` populated and the workflow advances to coder.
- [x] 6.3 Add an integration test for `cancel` arriving during clarification wait; assert the workflow ends `cancelled` without re-invoking the spec phase.
- [x] 6.4 Add a unit test for the malformed-signal-payload path: signal with bad shape leaves the workflow waiting and a subsequent valid signal still works.
- [x] 6.5 Add a test for `resolveClarificationSubTicketActivity` failing — workflow should still re-dispatch the spec phase.

## 7. Cleanup and docs

- [x] 7.1 Search the codebase for remaining references to `AcClarificationRequested` and `SPEC_AC_CLARIFICATION_FAILURE_TYPE`; remove them. Leave a note in `linear-poller.ts` comments updating the rationale (clarifications no longer rely on `ALLOW_DUPLICATE_FAILED_ONLY`).
- [x] 7.2 Update operator notes in any internal runbook (e.g. README sections referencing AC clarification recovery) to describe the new Temporal-UI signal flow. (Skip if no such doc exists.)

## 8. Verification

- [x] 8.1 Run `TEMPORAL_TASK_QUEUE=local-test npm test` from the repo root and confirm all suites pass.
- [x] 8.2 Manual UI verification deferred — superseded by integration tests in `temporal.ticketWorkflows.test.ts` that exercise the same end-to-end flow against a real Temporal namespace (clarification signal flow, cancel-during-wait, malformed-signal recovery, sub-ticket-resolve-failure best-effort, shared budget exhaustion, early-signal rejection, immediate query-clear). The signal/query wire format is identical to what the Web UI sends, so an additional manual run would not exercise any path not already covered.
- [x] 8.3 Run `openspec validate clarification-via-signals --strict` and resolve any issues.
