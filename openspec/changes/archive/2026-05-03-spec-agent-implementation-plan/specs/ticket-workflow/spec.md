## MODIFIED Requirements

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
