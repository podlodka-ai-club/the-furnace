## MODIFIED Requirements

### Requirement: Per-Ticket Workflow Runs Three Ordered Phases

The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`. The spec phase SHALL be a real activity that produces a feature branch and failing-test commits, while coder and review phases remain no-op stubs until their own changes land.

#### Scenario: Ticket workflow advances through all phases

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the coder and review phases MAY remain no-op stubs that log and return contract-shaped placeholders

### Requirement: No-op Phase Implementations Return Valid Contract Shapes

Coder and review phase implementations that remain as no-op stubs SHALL return placeholder payloads that conform to their corresponding contract schemas. The spec phase no longer falls under this requirement because it has a real implementation.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op coder or review phase activities execute in the workflow
- **THEN** each phase output MUST pass its output `schema.parse()` check without schema errors

## ADDED Requirements

### Requirement: Workflow Records Attempts Row Around Spec Phase

The workflow SHALL invoke a `recordAttempt` orchestrator-side activity around every spec phase execution so that one `attempts` row is persisted per invocation, regardless of whether the phase succeeded, requested clarification, or threw an internal error.

#### Scenario: Spec phase succeeds

- **WHEN** the spec phase returns a valid `SpecPhaseOutput`
- **THEN** the workflow MUST record an `attempts` row with `outcome = 'passed'`, the workflow's run id, `phase = 'spec'`, and the current attempt index

#### Scenario: Spec phase requests AC clarification

- **WHEN** the spec phase throws an `AcClarificationRequested` non-retryable failure
- **THEN** the workflow MUST record an `attempts` row with `outcome = 'stuck'`
- **AND** the row MUST be written before the workflow transitions to its terminal state

#### Scenario: Spec phase throws internal error

- **WHEN** the spec phase throws any other failure (after Temporal retries are exhausted or for a non-retryable reason other than clarification)
- **THEN** the workflow MUST record an `attempts` row with `outcome = 'failed'`

### Requirement: AC Clarification Failure Pauses Workflow Pending Human

The workflow SHALL recognize `AcClarificationRequested` non-retryable failures from the spec phase as a structured human-pause signal, persist the run as `failed` with the structured failure detail describing the sub-ticket, and SHALL NOT advance to the coder phase.

#### Scenario: Clarification path detected

- **WHEN** the spec phase throws an `AcClarificationRequested` failure carrying a sub-ticket reference
- **THEN** the workflow MUST catch the failure and stop before invoking `runCoderPhase`
- **AND** the workflow MUST update the persisted `workflow_runs` row with `status = 'failed'` and a structured failure detail that includes the sub-ticket `{ id, identifier, title }`
- **AND** the corresponding Linear ticket MUST remain in its `In Progress` state (the workflow MUST NOT cancel it)

#### Scenario: Other failures bubble normally

- **WHEN** the spec phase throws any failure other than `AcClarificationRequested`
- **THEN** the workflow MUST surface it via Temporal's normal retry and failure semantics
- **AND** the workflow MUST NOT treat it as a human-pause state
