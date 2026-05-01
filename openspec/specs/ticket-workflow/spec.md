# ticket-workflow Specification

## Purpose

Defines typed phase boundaries for the ticket workflow so no-op and future real phase implementations exchange contract-validated payloads.
## Requirements
### Requirement: Typed Phase Activity Boundaries

The ticket workflow SHALL type phase activity interfaces with canonical contract types (`SpecPhaseOutput`, `CoderPhaseOutput`, and `ReviewResult`) instead of untyped or void payloads, and `CoderPhaseOutput` SHALL represent either a successful diff-manifest result or a typed stuck-with-sub-ticket result.

#### Scenario: Workflow phase signatures use contract types

- **WHEN** developers inspect or compile workflow and activity interfaces
- **THEN** the spec, coder, and review phase signatures MUST reference canonical inferred contract types
- **AND** coder output typing MUST support both successful diff-manifest payloads and typed stuck payloads

### Requirement: No-op Phase Implementations Return Valid Contract Shapes

Review phase implementations that remain as no-op stubs SHALL return placeholder payloads that conform to their corresponding contract schemas. The spec and coder phases no longer fall under this requirement because they have real implementations.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op review phase activity executes in the workflow
- **THEN** the phase output MUST pass its output `schema.parse()` check without schema errors

### Requirement: Poller Workflow Enqueues One Ticket Workflow Per Agent-Ready Todo Ticket
The system SHALL run a cron-based `LinearPollerWorkflow` that polls Linear for `agent-ready` tickets in `Todo` state and starts a `PerTicketWorkflow` for each discovered ticket using ticket-ID-based idempotency.

#### Scenario: Worker startup ensures cron schedule exists
- **WHEN** the Temporal worker process starts
- **THEN** it MUST create or reuse a named Temporal schedule that starts `LinearPollerWorkflow` on a recurring interval
- **AND** default poll cadence MUST be one minute unless overridden by environment configuration

#### Scenario: Poll cycle starts workflows for new todo tickets only
- **WHEN** `LinearPollerWorkflow` executes and receives a list of `agent-ready` tickets in `Todo` state
- **THEN** it MUST attempt to start one `PerTicketWorkflow` per ticket using a deterministic workflow ID derived from the ticket ID
- **AND** duplicate starts for already-running or already-started ticket workflow IDs MUST be treated as non-fatal and skipped

### Requirement: Per-Ticket Workflow Runs Three Ordered Phases

The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`. The spec and coder phases SHALL be real activities, while review may remain a no-op stub until its own change lands.

#### Scenario: Ticket workflow advances through all phases

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the coder phase MUST execute the real implementation loop that returns either a diff manifest or typed stuck output
- **AND** the review phase MAY remain a no-op stub that logs and returns a contract-shaped placeholder

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

### Requirement: Per-Ticket Workflow Supports Cancel Signal
The system SHALL expose a `cancel` signal on `PerTicketWorkflow` that causes the workflow to stop further phase execution and transition to a cancelled terminal state.

#### Scenario: Cancel arrives during execution
- **WHEN** `cancel` is signaled to a running `PerTicketWorkflow`
- **THEN** the workflow MUST stop before starting any remaining phases
- **AND** it MUST record cancellation in workflow state and persisted run status

### Requirement: Per-Ticket Workflow Exposes Phase and Attempt Queries
The system SHALL expose Temporal query handlers on `PerTicketWorkflow` for `currentPhase` and `attemptCount`.

#### Scenario: Operator inspects workflow state
- **WHEN** an operator queries `currentPhase` or `attemptCount` for a running or completed `PerTicketWorkflow`
- **THEN** the workflow MUST return the latest in-memory state for phase position and retry attempt count

### Requirement: Workflow Runs Are Persisted On Start and Phase Transitions
The system SHALL write a `workflow_runs` record when `PerTicketWorkflow` starts and SHALL update that record on each phase transition.

#### Scenario: Persistent status tracks lifecycle
- **WHEN** a `PerTicketWorkflow` begins and advances from spec to coder to review
- **THEN** persistence MUST contain a run row created at start
- **AND** that row MUST be updated at each phase transition with the current phase/status metadata
