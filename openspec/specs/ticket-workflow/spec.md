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
