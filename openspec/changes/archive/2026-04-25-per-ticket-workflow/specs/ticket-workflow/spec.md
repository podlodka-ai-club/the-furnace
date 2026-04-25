## ADDED Requirements

### Requirement: Poller Workflow Enqueues One Ticket Workflow Per Agent-Ready Todo Ticket
The system SHALL run a cron-based `LinearPollerWorkflow` that polls Linear for `agent-ready` tickets in `Todo` state and starts a `PerTicketWorkflow` for each discovered ticket using ticket-ID-based idempotency.

#### Scenario: Poll cycle starts workflows for new todo tickets only
- **WHEN** `LinearPollerWorkflow` executes and receives a list of `agent-ready` tickets in `Todo` state
- **THEN** it MUST attempt to start one `PerTicketWorkflow` per ticket using a deterministic workflow ID derived from the ticket ID
- **AND** duplicate starts for already-running or already-started ticket workflow IDs MUST be treated as non-fatal and skipped

### Requirement: Per-Ticket Workflow Runs Three Ordered No-Op Phases
The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`, where each activity is a no-op stub that logs and returns success.

#### Scenario: Ticket workflow advances through all phases
- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** each phase activity MUST complete successfully without implementing real agent logic

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
