## ADDED Requirements

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
