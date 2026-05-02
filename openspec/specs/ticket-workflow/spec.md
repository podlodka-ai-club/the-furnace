# ticket-workflow Specification

## Purpose

Defines typed phase boundaries for the ticket workflow so no-op and future real phase implementations exchange contract-validated payloads.
## Requirements
### Requirement: Typed Phase Activity Boundaries

The ticket workflow SHALL type phase activity interfaces with canonical contract types (`SpecPhaseOutput`, `CoderPhaseOutput`, and `ReviewResult`) instead of untyped or void payloads.

#### Scenario: Workflow phase signatures use contract types

- **WHEN** developers inspect or compile workflow and activity interfaces
- **THEN** the spec, coder, and review phase signatures MUST reference canonical inferred contract types

### Requirement: No-op Phase Implementations Return Valid Contract Shapes

Coder and review phase implementations that remain as no-op stubs SHALL return placeholder payloads that conform to their corresponding contract schemas. The spec phase no longer falls under this requirement because it has a real implementation.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op coder or review phase activities execute in the workflow
- **THEN** each phase output MUST pass its output `schema.parse()` check without schema errors

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

The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`. The spec phase SHALL be a real activity that produces a feature branch and failing-test commits, while coder and review phases remain no-op stubs until their own changes land.

#### Scenario: Ticket workflow advances through all phases

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the coder and review phases MAY remain no-op stubs that log and return contract-shaped placeholders

### Requirement: AC Clarification Failure Pauses Workflow Pending Human

The workflow SHALL recognize `AcClarificationRequested` non-retryable failures from the spec phase as a structured human-pause signal, surface the sub-ticket detail in Temporal failure metadata, and SHALL NOT advance to the coder phase.

#### Scenario: Clarification path detected

- **WHEN** the spec phase throws an `AcClarificationRequested` failure carrying a sub-ticket reference
- **THEN** the workflow MUST catch the failure and stop before invoking `runCoderPhase`
- **AND** the workflow failure detail MUST include the sub-ticket `{ id, identifier, title }`
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
- **AND** it MUST record cancellation in workflow state so Temporal surfaces the cancelled terminal status

### Requirement: Per-Ticket Workflow Exposes Phase and Attempt Queries
The system SHALL expose Temporal query handlers on `PerTicketWorkflow` for `currentPhase` and `attemptCount`.

#### Scenario: Operator inspects workflow state
- **WHEN** an operator queries `currentPhase` or `attemptCount` for a running or completed `PerTicketWorkflow`
- **THEN** the workflow MUST return the latest in-memory state for phase position and retry attempt count
