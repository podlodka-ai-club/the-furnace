## MODIFIED Requirements

### Requirement: Per-Ticket Workflow Runs Three Ordered Phases

The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`. The spec and coder phases SHALL each be a real activity — the spec phase produces a feature branch with failing-test commits and the coder phase makes those tests green on the same feature branch — while the review phase remains a no-op stub until its own change lands.

#### Scenario: Ticket workflow advances through all phases

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the coder phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the review phase MAY remain a no-op stub that logs and returns a contract-shaped placeholder

### Requirement: No-op Phase Implementations Return Valid Contract Shapes

Review phase implementations that remain as no-op stubs SHALL return placeholder payloads that conform to the `ReviewResult` contract schema. The spec and coder phases no longer fall under this requirement because they have real implementations.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op review phase activity executes in the workflow
- **THEN** the phase output MUST pass `reviewResultSchema.parse()` without schema errors

## ADDED Requirements

### Requirement: Coder Phase Receives Ticket And Spec Output

The workflow SHALL invoke `runCoderPhase` with an input that includes both the original ticket (so the prompt can reference its title and description) and the `SpecPhaseOutput` produced by the spec phase (so the activity can check out the feature branch and read the test paths).

#### Scenario: Workflow passes ticket and spec output

- **WHEN** the workflow advances from the spec phase to the coder phase
- **THEN** it MUST call `runCoderPhase({ ticket, specOutput })` where `ticket` is the workflow's input ticket and `specOutput` is the value returned by `runSpecPhase`

### Requirement: Coder Stuck Failures Pause Workflow Pending Human

The workflow SHALL recognize `DepMissingRequested` and `DesignQuestionRequested` non-retryable failures from the coder phase as structured human-pause signals, surface the sub-ticket detail in Temporal failure metadata, and SHALL NOT advance to the review phase.

#### Scenario: Dep-missing path detected

- **WHEN** the coder phase throws a `DepMissingRequested` failure carrying a sub-ticket reference
- **THEN** the workflow MUST catch the failure and stop before invoking `runReviewPhase`
- **AND** the workflow failure detail MUST include the sub-ticket `{ id, identifier, title }`
- **AND** the corresponding Linear ticket MUST remain in its `In Progress` state (the workflow MUST NOT cancel it)

#### Scenario: Design-question path detected

- **WHEN** the coder phase throws a `DesignQuestionRequested` failure carrying a sub-ticket reference
- **THEN** the workflow MUST catch the failure and stop before invoking `runReviewPhase`
- **AND** the workflow failure detail MUST include the sub-ticket `{ id, identifier, title }`
- **AND** the corresponding Linear ticket MUST remain in its `In Progress` state (the workflow MUST NOT cancel it)

#### Scenario: Other coder failures bubble normally

- **WHEN** the coder phase throws any failure other than `DepMissingRequested` or `DesignQuestionRequested`
- **THEN** the workflow MUST surface it via Temporal's normal retry and failure semantics
- **AND** the workflow MUST NOT treat it as a human-pause state

### Requirement: Cancel Signal Aborts Before Coder Phase Dispatch

The workflow's existing `cancel` signal SHALL stop the workflow before the coder phase is invoked when cancellation arrives during or after the spec phase, preserving the per-attempt ephemerality contract.

#### Scenario: Cancel arrives between spec and coder

- **WHEN** the spec phase has returned and `cancel` has been signaled
- **THEN** the workflow MUST NOT invoke `runCoderPhase`
- **AND** the workflow MUST transition to the cancelled terminal state

#### Scenario: Cancel arrives during coder phase

- **WHEN** `cancel` is signaled while the coder phase activity is in flight
- **THEN** the workflow MUST stop before invoking `runReviewPhase` once the coder phase resolves or is cancelled
- **AND** the workflow MUST transition to the cancelled terminal state
