# ticket-workflow Specification

## Purpose

Defines typed phase boundaries for the ticket workflow so no-op and future real phase implementations exchange contract-validated payloads.
## Requirements
### Requirement: Typed Phase Activity Boundaries

The ticket workflow SHALL type phase activity interfaces with canonical contract types (`SpecPhaseOutput`, `CoderPhaseOutput`, and `ReviewResult`) instead of untyped or void payloads.

#### Scenario: Workflow phase signatures use contract types

- **WHEN** developers inspect or compile workflow and activity interfaces
- **THEN** the spec, coder, and review phase signatures MUST reference canonical inferred contract types

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

### Requirement: Per-Ticket Workflow Runs Spec Then Bounded Coder-Review Rounds

The system SHALL execute `PerTicketWorkflow` as `runSpecPhase` followed by a bounded loop of `runCoderPhase` and `runReviewPhase` activities. The spec phase produces a feature branch with failing-test commits. Each round of the loop invokes `runCoderPhase` followed by `runReviewPhase`. The spec, coder, and review phases SHALL each be a real Claude-Agent-SDK-driven activity, not a no-op stub.

#### Scenario: Ticket workflow runs spec then enters round loop

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` first
- **AND** after the spec phase succeeds, it MUST enter a coder-review round loop
- **AND** within each round, it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec, coder, and review phases MUST all execute the real activity bodies, not no-op stubs

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

### Requirement: Workflow Opens Pull Request Once After First Coder Green

After the first successful `runCoderPhase` (round 0), the workflow SHALL invoke `openPullRequestActivity` exactly once with the coder phase's `featureBranch`, the workflow's `targetRepoSlug`, the workflow's input `ticket`, the workflow id, the current attempt count, the coder phase's `finalCommitSha`, a one-line `diffSummary` derived from the coder phase's `diffStat`, and the spec phase's `implementationPlan` from `specOutput.implementationPlan`. The PR SHALL be reused for all subsequent rounds; the workflow SHALL NOT re-open or re-create a PR on follow-up rounds.

#### Scenario: First coder green opens PR

- **WHEN** `runCoderPhase` returns successfully on round 0
- **THEN** the workflow MUST invoke `openPullRequestActivity` with the coder phase output, ticket, workflow id, attempt count, and the spec phase's `implementationPlan`
- **AND** the workflow MUST invoke the activity before the first `runReviewPhase` call

#### Scenario: PR opens once across rounds

- **WHEN** the workflow advances through follow-up rounds (round 1+)
- **THEN** the workflow MUST NOT invoke `openPullRequestActivity` again
- **AND** the existing PR number from round 0 MUST be reused as input to subsequent `runReviewPhase` and `postPullRequestReviewActivity` calls

#### Scenario: PR open is skipped when coder phase does not return green

- **WHEN** `runCoderPhase` throws on round 0 (including human-pause failures such as `DepMissingRequested` or `DesignQuestionRequested`)
- **THEN** the workflow MUST NOT invoke `openPullRequestActivity`

### Requirement: Per-Ticket Workflow Result Includes PR Reference On Success

The `PerTicketWorkflow` result SHALL include an optional `pr` field of shape `{ number: number; url: string }`. The field SHALL be present when the workflow status is `succeeded` and SHALL be absent when the status is `cancelled` or when the workflow ends due to a human-pause failure.

#### Scenario: Successful workflow returns PR reference

- **WHEN** a `PerTicketWorkflow` completes with `status: "succeeded"`
- **THEN** the workflow result MUST include a `pr` object containing `number` and `url` from the `openPullRequestActivity` result

#### Scenario: Cancelled workflow omits PR reference

- **WHEN** a `PerTicketWorkflow` completes with `status: "cancelled"`
- **THEN** the workflow result MUST NOT include a `pr` field

### Requirement: Workflow Posts Review To Pull Request After Each Round

After each `runReviewPhase` returns and before evaluating the verdict for loop control, the workflow SHALL invoke `postPullRequestReviewActivity` with the open PR number, the verdict, the reasoning as the review body, and the structured findings translated into per-file/line review comments. The post SHALL run for both the `approve` and `changes_requested` verdicts so the PR carries every round's review for human visibility.

#### Scenario: Post runs after every round

- **WHEN** `runReviewPhase` returns either verdict
- **THEN** the workflow MUST invoke `postPullRequestReviewActivity` before evaluating whether to break or continue the loop

#### Scenario: Post uses the existing PR number

- **WHEN** the workflow invokes `postPullRequestReviewActivity` on any round
- **THEN** the `prNumber` field MUST be the PR number returned by `openPullRequestActivity` in round 0

### Requirement: Review Verdict Drives Round Loop

After each round's review post, the workflow SHALL act on the verdict. On `verdict: "approve"`, the workflow SHALL break out of the round loop and complete with `status: "succeeded"`. On `verdict: "changes_requested"`, the workflow SHALL increment the round counter and, if the cap has not been reached, re-enter `runCoderPhase` with `priorReview: { prNumber, reviewSummary, findings }` populated from the review result.

#### Scenario: Approve verdict completes workflow

- **WHEN** `runReviewPhase` returns `verdict: "approve"`
- **THEN** the workflow MUST exit the round loop after posting the review
- **AND** the workflow MUST complete with `status: "succeeded"`

#### Scenario: Changes-requested verdict re-enters coder phase

- **WHEN** `runReviewPhase` returns `verdict: "changes_requested"` and the round cap has not been reached
- **THEN** the workflow MUST invoke `runCoderPhase` again with `priorReview` populated from the review result
- **AND** `priorReview.prNumber` MUST be the existing PR number opened in round 0
- **AND** `priorReview.findings` MUST be the structured findings from the prior review
- **AND** `priorReview.reviewSummary` MUST be the prior review's `reasoning` field

### Requirement: Review Round Cap Bounded By MAX_REVIEW_ROUNDS

The workflow SHALL bound the coder-review loop by a configurable cap `MAX_REVIEW_ROUNDS` defined in the dispatch module alongside `PHASE_MAX_ATTEMPTS`, defaulting to `3`. The cap counts total rounds (round 0 plus follow-up rounds), so the workflow performs at most `MAX_REVIEW_ROUNDS` invocations of `runReviewPhase`.

#### Scenario: Default cap is three rounds

- **WHEN** `MAX_REVIEW_ROUNDS` is not overridden
- **THEN** the workflow MUST execute at most three rounds of coder-review

#### Scenario: Configured cap is honored

- **WHEN** `MAX_REVIEW_ROUNDS` is overridden via configuration
- **THEN** the workflow MUST execute at most that many rounds of coder-review

### Requirement: Round Cap Exhaustion Surfaces Non-Retryable Failure

When the round loop reaches `MAX_REVIEW_ROUNDS` rounds with no `approve` verdict, the workflow SHALL throw a non-retryable `ApplicationFailure` of type `ReviewRoundCapExhausted` carrying the last review's verdict, reasoning, and findings as failure detail. The Linear ticket SHALL remain in `In Progress` state for human takeover. The PR SHALL remain open with the last review attached.

#### Scenario: Cap reached with last verdict changes-requested

- **WHEN** the workflow finishes round `MAX_REVIEW_ROUNDS - 1` with `verdict: "changes_requested"`
- **THEN** the workflow MUST throw `ApplicationFailure.nonRetryable` of type `ReviewRoundCapExhausted`
- **AND** the failure detail MUST include the last review's verdict, reasoning, and findings
- **AND** the workflow MUST NOT cancel the Linear ticket or change its state from `In Progress`
- **AND** the PR MUST remain open

### Requirement: Cancel Signal Honored Between Rounds

The workflow's existing `cancel` signal SHALL be checked at the top of each round iteration. When a cancel arrives between two rounds (after one round's review post and before the next round's coder dispatch), the workflow SHALL NOT invoke another `runCoderPhase` and SHALL transition to the cancelled terminal state.

#### Scenario: Cancel between rounds

- **WHEN** `cancel` is signaled after a round's `postPullRequestReviewActivity` returns and before the next `runCoderPhase` dispatch
- **THEN** the workflow MUST NOT invoke another `runCoderPhase`
- **AND** the workflow MUST NOT invoke another `runReviewPhase`
- **AND** the workflow MUST transition to the cancelled terminal state

### Requirement: Per-Ticket Workflow Exposes Round Counter Query

The workflow SHALL expose a Temporal query handler `currentRound` returning the zero-based index of the round currently in flight (or most recently completed when the workflow has terminated). The handler SHALL be available alongside the existing `currentPhase` and `attemptCount` queries.

#### Scenario: Operator inspects round progress

- **WHEN** an operator queries `currentRound` for a running or completed `PerTicketWorkflow`
- **THEN** the workflow MUST return the latest in-memory round index
- **AND** the value MUST be `0` before the first review completes
