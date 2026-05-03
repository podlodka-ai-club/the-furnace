## MODIFIED Requirements

### Requirement: Per-Ticket Workflow Runs Spec Then Bounded Coder-Review Rounds

The system SHALL execute `PerTicketWorkflow` as `runSpecPhase` followed by a bounded loop of `runCoderPhase` and `runReviewPhase` activities. The spec phase produces a feature branch with failing-test commits. Each round of the loop invokes `runCoderPhase` followed by `runReviewPhase`. The spec, coder, and review phases SHALL each be a real Claude-Agent-SDK-driven activity, not a no-op stub.

#### Scenario: Ticket workflow runs spec then enters round loop

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` first
- **AND** after the spec phase succeeds, it MUST enter a coder-review round loop
- **AND** within each round, it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec, coder, and review phases MUST all execute the real activity bodies, not no-op stubs

### Requirement: Workflow Opens Pull Request Once After First Coder Green

After the first successful `runCoderPhase` (round 0), the workflow SHALL invoke `openPullRequestActivity` exactly once with the coder phase's `featureBranch`, the workflow's `targetRepoSlug`, the workflow's input `ticket`, the workflow id, the current attempt count, the coder phase's `finalCommitSha`, and a one-line `diffSummary` derived from the coder phase's `diffStat`. The PR SHALL be reused for all subsequent rounds; the workflow SHALL NOT re-open or re-create a PR on follow-up rounds.

#### Scenario: First coder green opens PR

- **WHEN** `runCoderPhase` returns successfully on round 0
- **THEN** the workflow MUST invoke `openPullRequestActivity` with the coder phase output, ticket, workflow id, and attempt count
- **AND** the workflow MUST invoke the activity before the first `runReviewPhase` call

#### Scenario: PR opens once across rounds

- **WHEN** the workflow advances through follow-up rounds (round 1+)
- **THEN** the workflow MUST NOT invoke `openPullRequestActivity` again
- **AND** the existing PR number from round 0 MUST be reused as input to subsequent `runReviewPhase` and `postPullRequestReviewActivity` calls

#### Scenario: PR open is skipped when coder phase does not return green

- **WHEN** `runCoderPhase` throws on round 0 (including human-pause failures such as `DepMissingRequested` or `DesignQuestionRequested`)
- **THEN** the workflow MUST NOT invoke `openPullRequestActivity`

## REMOVED Requirements

### Requirement: No-op Phase Implementations Return Valid Contract Shapes
**Reason**: The review phase now has a real implementation; no phase is a no-op stub.
**Migration**: The real `runReviewAgent` validates its output against `reviewResultSchema` per the `single-review-with-feedback-loop` capability. There is no remaining no-op phase whose placeholder needs schema-compatibility coverage.

## ADDED Requirements

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
