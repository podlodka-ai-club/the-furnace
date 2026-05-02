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

Review phase implementations that remain as no-op stubs SHALL return placeholder payloads that conform to the `ReviewResult` contract schema. The spec and coder phases no longer fall under this requirement because they have real implementations.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op review phase activity executes in the workflow
- **THEN** the phase output MUST pass `reviewResultSchema.parse()` without schema errors

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

The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`. The spec and coder phases SHALL each be a real activity — the spec phase produces a feature branch with failing-test commits and the coder phase makes those tests green on the same feature branch — while the review phase remains a no-op stub until its own change lands.

#### Scenario: Ticket workflow advances through all phases

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the coder phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the review phase MAY remain a no-op stub that logs and returns a contract-shaped placeholder

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

### Requirement: Workflow Opens Pull Request After Coder Green

After `runCoderPhase` returns successfully, the workflow SHALL invoke `openPullRequestActivity` with the coder phase's `featureBranch`, the workflow's `targetRepoSlug`, the workflow's input `ticket`, the workflow id, the current attempt count, the coder phase's `finalCommitSha`, and a one-line `diffSummary` derived from the coder phase's `diffStat`. The call SHALL occur before the existing no-op `runReviewPhase` call so the workflow shape `spec → coder → review → completed` survives.

The call site SHALL carry a `TODO(review-agent)` comment indicating the PR-open call will move onto the review approve path (gated on `reviewOutput.verdict === "approve"`) once the `review-agent` change lands.

#### Scenario: Coder green path opens PR before review stub

- **WHEN** `runCoderPhase` returns successfully
- **THEN** the workflow MUST invoke `openPullRequestActivity` with the coder phase output, ticket, workflow id, and attempt count
- **AND** the workflow MUST invoke the activity before the existing no-op `runReviewPhase` call

#### Scenario: PR open is skipped when coder phase does not return green

- **WHEN** `runCoderPhase` throws (including human-pause failures such as `DepMissingRequested` or `DesignQuestionRequested`)
- **THEN** the workflow MUST NOT invoke `openPullRequestActivity`

#### Scenario: Splice point is marked for review-agent

- **WHEN** the source for `PerTicketWorkflow` is inspected
- **THEN** the `openPullRequestActivity` call site MUST be annotated with a `TODO(review-agent)` comment describing the future move to the review approve path

### Requirement: Per-Ticket Workflow Result Includes PR Reference On Success

The `PerTicketWorkflow` result SHALL include an optional `pr` field of shape `{ number: number; url: string }`. The field SHALL be present when the workflow status is `succeeded` and SHALL be absent when the status is `cancelled` or when the workflow ends due to a human-pause failure.

#### Scenario: Successful workflow returns PR reference

- **WHEN** a `PerTicketWorkflow` completes with `status: "succeeded"`
- **THEN** the workflow result MUST include a `pr` object containing `number` and `url` from the `openPullRequestActivity` result

#### Scenario: Cancelled workflow omits PR reference

- **WHEN** a `PerTicketWorkflow` completes with `status: "cancelled"`
- **THEN** the workflow result MUST NOT include a `pr` field
