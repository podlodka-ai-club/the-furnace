## MODIFIED Requirements

### Requirement: Agent Exposes Exactly Two Decision Tools

The spec agent SHALL be given exactly two custom tools — `propose_failing_tests` and `request_ac_clarification` — and MUST commit to one of them as its terminal action. Free-form prose without a tool call SHALL be treated as a model failure. The `propose_failing_tests` tool's argument schema SHALL require both the failing test files AND a structured implementation plan.

#### Scenario: Agent proposes failing tests with plan

- **WHEN** the agent calls `propose_failing_tests({ files: [{ path, contents, description }, …], implementationPlan: { summary, workItems } })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to write each test file, verify failure, commit each test file, push the branch, and return the plan in the `SpecPhaseOutput` payload of a `kind: "done"` result

#### Scenario: Agent requests AC clarification

- **WHEN** the agent calls `request_ac_clarification({ reason, questions })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to open a Linear sub-ticket and return an `AwaitingClarification` result so the workflow can wait for an operator signal

#### Scenario: Agent returns prose without tool call

- **WHEN** the agent ends its turn without calling either tool
- **THEN** the activity MUST send a corrective message instructing the agent to pick a tool
- **AND** the activity MUST allow up to 3 such corrections within the same SDK conversation
- **AND** if the budget is exhausted, the activity MUST throw a retryable error so Temporal launches a fresh container

### Requirement: Spec Agent Surfaces Plan Ambiguity Through Existing Clarification Tool

If the spec agent cannot articulate a coherent implementation plan from the ticket — even if it could write a partial test — it SHALL call `request_ac_clarification` rather than submit a partial plan. Plan ambiguity SHALL NOT introduce a new clarification tool; it reuses the AC-clarification path.

#### Scenario: Plan-blocked ticket reuses AC clarification

- **WHEN** the spec agent determines it cannot produce both a failing test AND a coherent plan from the ticket
- **THEN** it MUST call `request_ac_clarification({ reason, questions })`
- **AND** the activity MUST handle that call exactly as it handles any other AC clarification (open a Linear sub-ticket of type `ac-clarification`, return an `AwaitingClarification` result for the workflow to wait on)

## ADDED Requirements

### Requirement: AC Clarification Opens Sub-Ticket And Returns Awaiting Result

When the agent calls `request_ac_clarification`, the activity SHALL open a Linear sub-ticket of type `ac-clarification` against the parent ticket and SHALL return a discriminated result of shape `{ kind: "awaiting_clarification", subTicketRef, reason, questions }` so the workflow can wait for an operator signal. The activity SHALL NOT throw to indicate clarification is needed.

#### Scenario: Sub-ticket creation succeeds

- **WHEN** the agent calls `request_ac_clarification({ reason, questions })`
- **THEN** the activity MUST call `linearClient.createSubTicket(parentId, "ac-clarification", body, workflowDeepLink)` where `body` formats `questions` as a checklist
- **AND** `workflowDeepLink` MUST point to the Temporal Web URL for the current workflow run, derived from the `TEMPORAL_WEB_BASE` env var
- **AND** the activity MUST return `{ kind: "awaiting_clarification", subTicketRef: { id, identifier, title }, reason, questions }`
- **AND** the activity MUST NOT throw `AcClarificationRequested` or any other failure

#### Scenario: Sub-ticket creation fails (Linear outage)

- **WHEN** `createSubTicket` throws because Linear is unreachable
- **THEN** the activity MUST throw a *retryable* error
- **AND** Temporal MUST be allowed to retry the entire spec phase

### Requirement: Spec Activity Accepts Prior Clarification Answers In Input

The spec activity input schema SHALL accept an optional `priorClarifications` array, each entry of shape `{ reason: string; questions: string[]; answer: string; resolvedBy?: string }`. When non-empty, the activity SHALL render the prior question/answer pairs into the agent's prompt under a `## Prior clarifications` section so the agent has the operator's response in context.

#### Scenario: Re-dispatch with answer threads context into prompt

- **WHEN** the workflow re-invokes `runSpecPhase` after receiving an operator signal, with `priorClarifications` set
- **THEN** the rendered prompt MUST include each prior `(reason, questions, answer)` triple in chronological order under a `## Prior clarifications` heading
- **AND** the prompt rendering MUST otherwise be identical to the first invocation

#### Scenario: Empty or missing priorClarifications behaves as today

- **WHEN** `priorClarifications` is absent or an empty array
- **THEN** the rendered prompt MUST NOT include a `## Prior clarifications` section
- **AND** the prompt MUST be identical to the pre-change behavior

### Requirement: Spec Activity Result Is A Discriminated Union

The spec activity SHALL return a discriminated union `SpecPhaseResult` of shape `{ kind: "done"; output: SpecPhaseOutput } | { kind: "awaiting_clarification"; subTicketRef; reason; questions }`. The activity SHALL NOT use thrown failures to communicate clarification state.

#### Scenario: Successful spec returns done variant

- **WHEN** the spec activity completes the failing-test push successfully
- **THEN** it MUST return `{ kind: "done", output }` where `output` parses against `specPhaseOutputSchema`

#### Scenario: Clarification needed returns awaiting variant

- **WHEN** the agent's terminal decision is `request_ac_clarification`
- **THEN** the activity MUST return `{ kind: "awaiting_clarification", subTicketRef, reason, questions }`
- **AND** the returned value MUST parse against the `specPhaseResultSchema` discriminated-union schema

## REMOVED Requirements

### Requirement: AC Clarification Opens Sub-Ticket and Fails Non-Retryably

**Reason**: The clarification path no longer terminates the workflow as a failure. The sub-ticket is still created, but the activity now returns a structured `AwaitingClarification` result and the workflow waits on a `clarificationAnswer` signal — see the ADDED requirement "AC Clarification Opens Sub-Ticket And Returns Awaiting Result" and the `ticket-workflow` capability's signal-and-wait requirement.
**Migration**: Activities and tests that previously asserted on a thrown `AcClarificationRequested` failure must be updated to assert on the returned `kind: "awaiting_clarification"` discriminator and its payload. The `SPEC_FAILURE_TYPES.acClarificationRequested` constant is removed; consumers should branch on the result discriminator instead.
