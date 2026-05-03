## ADDED Requirements

### Requirement: Coder Activity Accepts Optional Prior Review On Follow-Up Rounds

The `coderPhaseInputSchema` SHALL gain an optional `priorReview` field of shape `{ prNumber: number; reviewSummary: string; findings: Finding[] }` where `Finding` is `{ path: string; line?: number; severity: "blocking" | "advisory"; message: string }`. The field SHALL be absent on the first round (round 0) and present on follow-up rounds (round 1+) when the workflow re-enters the coder phase after a `changes_requested` verdict.

#### Scenario: Round 0 omits priorReview

- **WHEN** the workflow invokes `runCoderPhase` for the first time on a ticket
- **THEN** the input MUST NOT include a `priorReview` field
- **AND** `coderPhaseInputSchema.parse(input)` MUST succeed

#### Scenario: Follow-up round includes priorReview

- **WHEN** the workflow invokes `runCoderPhase` after a `changes_requested` verdict
- **THEN** the input MUST include `priorReview` with the PR number, review summary, and structured findings from the prior review
- **AND** `coderPhaseInputSchema.parse(input)` MUST succeed

### Requirement: Coder Prompt Incorporates Prior-Review Findings

When `priorReview` is present in the activity input, the activity SHALL augment the SDK prompt with the prior review's summary and the list of findings (path, line, severity, message). The agent SHALL be instructed to address the findings in addition to keeping the spec tests green.

#### Scenario: Prompt augmented on follow-up rounds

- **WHEN** the activity instantiates the SDK conversation with `priorReview` present in input
- **THEN** the prompt MUST include `priorReview.reviewSummary` verbatim
- **AND** the prompt MUST list each finding with its `path`, optional `line`, `severity`, and `message`
- **AND** the prompt MUST instruct the agent to address the findings while keeping the spec tests green

#### Scenario: Prompt unchanged on round 0

- **WHEN** the activity instantiates the SDK conversation with no `priorReview` field
- **THEN** the prompt MUST NOT contain a prior-review section

### Requirement: Coder Activity Sources Findings Only From Input

The coder activity SHALL NOT call the GitHub API from inside the per-attempt container to fetch PR review comments. The PR number, review summary, and findings MUST be sourced exclusively from the workflow-supplied `priorReview` input field.

#### Scenario: No GitHub API calls from container

- **WHEN** the coder activity runs on any round
- **THEN** it MUST NOT issue any HTTPS request to `api.github.com`
- **AND** the per-attempt container MUST NOT carry a GitHub-scoped credential in its environment

#### Scenario: Findings sourced from workflow input

- **WHEN** the coder activity runs on a follow-up round
- **THEN** it MUST read the prior review only from `input.priorReview`
- **AND** it MUST NOT fetch PR review comments via the GitHub API
