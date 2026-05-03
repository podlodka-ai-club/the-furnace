## ADDED Requirements

### Requirement: Workflow Waits On Clarification Signal When Spec Returns Awaiting Result

The workflow SHALL recognize a spec phase result of shape `{ kind: "awaiting_clarification", subTicketRef, reason, questions }` as a structured human-pause state, record the clarification details in workflow state, and `await condition(...)` until either a `clarificationAnswer` signal arrives or a `cancel` signal arrives. The workflow SHALL NOT advance to the coder phase while waiting. The Linear ticket SHALL remain in `In Progress` state during the wait.

#### Scenario: Spec phase returns awaiting result

- **WHEN** `runSpecPhase` returns a result with `kind: "awaiting_clarification"`
- **THEN** the workflow MUST store `{ subTicketRef, reason, questions, askedAt }` as the current clarification state
- **AND** the workflow MUST NOT invoke `runCoderPhase`
- **AND** the corresponding Linear ticket MUST remain in `In Progress` state

#### Scenario: Cancel during clarification wait

- **WHEN** the workflow is waiting on a clarification signal and a `cancel` signal arrives first
- **THEN** the workflow MUST exit the wait loop without re-dispatching the spec phase
- **AND** the workflow MUST transition to the cancelled terminal state via the existing `transitionToCancelled` flow

#### Scenario: Other spec failures bubble normally

- **WHEN** the spec phase throws any failure (i.e. returns no result at all)
- **THEN** the workflow MUST surface it via Temporal's normal retry and failure semantics
- **AND** the workflow MUST NOT treat it as a clarification-pause state

### Requirement: Per-Ticket Workflow Defines Clarification Answer Signal

The workflow SHALL define a `clarificationAnswer` signal carrying a payload of shape `{ answer: string; resolvedBy?: string }`. Receipt of the signal SHALL set the in-memory clarification answer and unblock the wait condition. The signal handler SHALL validate the payload against a Zod schema; malformed payloads SHALL be rejected without unblocking the wait.

#### Scenario: Operator sends valid signal

- **WHEN** an operator sends `clarificationAnswer({ answer: "use UTF-8", resolvedBy: "alice@example.com" })` while the workflow is waiting
- **THEN** the workflow MUST record the answer and operator
- **AND** the wait condition MUST resolve so execution continues to the re-dispatch step

#### Scenario: Malformed signal payload rejected

- **WHEN** an operator sends a `clarificationAnswer` signal whose payload fails Zod validation
- **THEN** the workflow MUST log the rejection and remain in the waiting state
- **AND** the workflow MUST be able to receive a corrected signal subsequently

#### Scenario: Signal arrives after answer already received

- **WHEN** a second `clarificationAnswer` signal arrives after the first has already unblocked the wait
- **THEN** the second signal MUST be ignored (no-op) for the resolved clarification

### Requirement: Per-Ticket Workflow Re-Dispatches Spec Phase With Answer

After receiving a `clarificationAnswer` signal, the workflow SHALL re-invoke the spec phase via the existing `runPhase("spec", ...)` retry machinery, passing the prior `(reason, questions, answer, resolvedBy)` history into the activity input as `priorClarifications`. Re-dispatch SHALL count against `PHASE_MAX_ATTEMPTS`. If the re-dispatched spec phase returns another `awaiting_clarification` result, the workflow SHALL append to the `priorClarifications` history and wait again.

#### Scenario: Answer threads into next spec attempt

- **WHEN** a `clarificationAnswer` signal arrives and the wait unblocks
- **THEN** the workflow MUST invoke `runSpecPhase` again with `priorClarifications` containing the answered triple
- **AND** the re-dispatch MUST consume one slot from `PHASE_MAX_ATTEMPTS`

#### Scenario: Repeated clarification rounds accumulate history

- **WHEN** the re-dispatched spec phase returns another `kind: "awaiting_clarification"` result
- **THEN** the workflow MUST append the new clarification to `priorClarifications` and wait for another signal
- **AND** the next re-dispatch MUST pass *all* prior clarification triples in chronological order

#### Scenario: Re-dispatch exhausts attempt budget

- **WHEN** `PHASE_MAX_ATTEMPTS` has been consumed across initial spec and clarification re-dispatches without producing a `kind: "done"` result
- **THEN** the workflow MUST surface the most recent failure via Temporal's normal retry exhaustion semantics

### Requirement: Per-Ticket Workflow Exposes Current Clarification Query

The workflow SHALL expose a Temporal query handler `currentClarification` returning `{ subTicketRef: { id; identifier; title }; reason; questions; askedAt } | undefined`. The handler SHALL return the active clarification while the workflow is waiting and SHALL return `undefined` once the wait has resolved (or before any clarification has been requested).

#### Scenario: Operator inspects pending clarification

- **WHEN** an operator queries `currentClarification` while the workflow is waiting on a clarification signal
- **THEN** the handler MUST return the active clarification payload including the sub-ticket reference and questions

#### Scenario: Query before or after wait

- **WHEN** an operator queries `currentClarification` before any clarification has been requested or after a signal has resolved the wait
- **THEN** the handler MUST return `undefined`

### Requirement: Workflow Resolves Clarification Sub-Ticket On Signal

When a `clarificationAnswer` signal is received, the workflow SHALL invoke an activity (`resolveClarificationSubTicketActivity`) that posts the operator's answer as a comment on the Linear sub-ticket and transitions the sub-ticket to its `Done` state. Failures of this activity SHALL be retried per Temporal defaults but SHALL NOT block the workflow from re-dispatching the spec phase — the workflow's source of truth is the signal, not the sub-ticket.

#### Scenario: Sub-ticket comment and close on answer

- **WHEN** the workflow has received a `clarificationAnswer` signal carrying `{ answer, resolvedBy }`
- **THEN** the workflow MUST invoke `resolveClarificationSubTicketActivity({ subTicketId, answer, resolvedBy })`
- **AND** the activity MUST post the answer as a Linear comment and transition the sub-ticket to `Done`

#### Scenario: Sub-ticket resolution failure does not block re-dispatch

- **WHEN** `resolveClarificationSubTicketActivity` exhausts its retries (e.g. Linear is down for an extended outage)
- **THEN** the workflow MUST log the failure
- **AND** the workflow MUST still proceed to re-dispatch `runSpecPhase` using the operator's answer

## REMOVED Requirements

### Requirement: AC Clarification Failure Pauses Workflow Pending Human

**Reason**: The clarification path no longer fails the workflow. Instead, the spec activity returns a structured awaiting result, and the workflow waits on a `clarificationAnswer` signal that operators can send from the Temporal Web UI. See the ADDED requirements `Workflow Waits On Clarification Signal When Spec Returns Awaiting Result`, `Per-Ticket Workflow Defines Clarification Answer Signal`, `Per-Ticket Workflow Re-Dispatches Spec Phase With Answer`, `Per-Ticket Workflow Exposes Current Clarification Query`, and `Workflow Resolves Clarification Sub-Ticket On Signal`.
**Migration**: Workflows started before deploy still surface the old `AcClarificationRequested` failure and remain recoverable via the existing Linear-poller `ALLOW_DUPLICATE_FAILED_ONLY` mechanism. Workflows started after deploy use the signal flow exclusively. Tests that assert on `stuckFailureTypes` containing `AcClarificationRequested` must be removed.
