# github-pr-open Specification

## Purpose

Defines the orchestrator-side activity that opens a GitHub pull request from a successful coder feature branch, including its inputs, body composition, idempotency on duplicate creation, retry classification, and resolution of the GitHub token and model identifier at activity boundary.

## Requirements

### Requirement: Open Pull Request Activity Exists On Orchestrator Queue

The system SHALL expose an `openPullRequestActivity` registered on the orchestrator worker (the same task queue that hosts other workflow-side activities such as `syncLinearTicketStateActivity`), not on per-attempt container workers. The activity SHALL accept the head feature branch name, the target repo slug, the ticket reference (`{ id, identifier, title, description }`), the workflow id, the attempt count, the final commit SHA, and a diff summary string.

#### Scenario: Activity registered on orchestrator worker

- **WHEN** the orchestrator worker boots
- **THEN** `openPullRequestActivity` MUST be present in its activity registry
- **AND** the activity MUST NOT be registered on any per-attempt container worker

#### Scenario: Activity input carries workflow traceability fields

- **WHEN** the workflow invokes `openPullRequestActivity`
- **THEN** the input MUST include `featureBranch`, `targetRepoSlug`, `ticket`, `workflowId`, `attemptCount`, `finalCommitSha`, and `diffSummary`

### Requirement: Model Identifier Resolved From Worker Environment

The activity SHALL resolve the `Model` metadata value from the orchestrator worker's `CLAUDE_MODEL` environment variable at activity execution time. When `CLAUDE_MODEL` is unset, the activity SHALL fall back to the literal string `"unknown"` so the metadata block remains well-formed without forcing a deploy-time configuration step. This avoids forcing the (deterministic) workflow to source the model identifier itself.

#### Scenario: CLAUDE_MODEL set in worker env

- **WHEN** the activity executes and `CLAUDE_MODEL` is set
- **THEN** the metadata block's `Model:` line MUST contain the env var value verbatim

#### Scenario: CLAUDE_MODEL unset in worker env

- **WHEN** the activity executes and `CLAUDE_MODEL` is not set
- **THEN** the metadata block's `Model:` line MUST contain the literal string `unknown`

### Requirement: Pull Request Targets Repo Registry Default Branch

The activity SHALL resolve the GitHub `owner`, `name`, and base `ref` from the repo registry entry keyed by `targetRepoSlug` and SHALL open the pull request from `featureBranch` against that base `ref`.

#### Scenario: Registry lookup drives PR coordinates

- **WHEN** the activity executes for a known `targetRepoSlug`
- **THEN** it MUST load the registry via the existing `loadRepoSlugRegistry()` / `findRegistryEntry()` helpers
- **AND** the GitHub PR head MUST be the supplied `featureBranch`
- **AND** the GitHub PR base MUST be the registry entry's `ref`
- **AND** the GitHub PR repo MUST be `<owner>/<name>` from the registry entry

#### Scenario: Unknown repo slug fails non-retryably

- **WHEN** the activity executes with a `targetRepoSlug` not present in the registry
- **THEN** it MUST throw a non-retryable `ApplicationFailure`

### Requirement: Pull Request Title Derives From Ticket

The pull request title SHALL be `${ticket.identifier}: ${ticket.title}`, truncated to at most 72 characters with a trailing `…` if truncation occurs.

#### Scenario: Short title used verbatim

- **WHEN** the combined `${identifier}: ${title}` length is at most 72 characters
- **THEN** the PR title MUST equal that combined string with no modification

#### Scenario: Long title truncated with ellipsis

- **WHEN** the combined `${identifier}: ${title}` length exceeds 72 characters
- **THEN** the PR title MUST be truncated to 72 characters total
- **AND** the final character MUST be `…`

### Requirement: Pull Request Body Contains Ticket Context, Diff Summary, Workflow Link, And Metadata Block

The pull request body SHALL include, in order: the ticket description verbatim, an `## Implementation plan` section rendered from the supplied `implementationPlan`, a one-line diff summary derived from the supplied `diffSummary`, a link to the Temporal workflow execution, and a fenced metadata block delimited by `<!-- furnace:metadata -->` and `<!-- /furnace:metadata -->` HTML comments.

The metadata block SHALL contain one `Key: Value` line per field, with the keys `Workflow-Id`, `Ticket-Id`, `Ticket-Identifier`, `Attempt-Count`, `Model`, and `Final-Commit`.

#### Scenario: Body includes ticket description and diff summary

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain the ticket description verbatim
- **AND** the body MUST contain a one-line diff summary derived from the supplied `diffSummary`

#### Scenario: Body includes implementation plan section

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain exactly one `## Implementation plan` heading, emitted by the shared plan-Markdown formatter
- **AND** that section MUST appear after the ticket description and before the diff summary
- **AND** the body composer MUST NOT add a separate `## Implementation plan` heading around the formatter's output
- **AND** the rendered Markdown MUST be a deterministic function of the input plan (same plan → byte-identical Markdown)

#### Scenario: Body links to Temporal workflow execution

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain a hyperlink to the workflow execution constructed via the existing workflow deep-link helper

#### Scenario: Metadata block is machine-parseable

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain exactly one block delimited by `<!-- furnace:metadata -->` and `<!-- /furnace:metadata -->`
- **AND** the block MUST contain `Workflow-Id: <workflowId>`
- **AND** the block MUST contain `Ticket-Id: <ticket.id>`
- **AND** the block MUST contain `Ticket-Identifier: <ticket.identifier>`
- **AND** the block MUST contain `Attempt-Count: <attemptCount>`
- **AND** the block MUST contain `Model: <model>`
- **AND** the block MUST contain `Final-Commit: <finalCommitSha>`

### Requirement: Open Pull Request Activity Accepts Implementation Plan Input

The `openPullRequestActivity` input schema SHALL include a required `implementationPlan` field whose shape matches the `implementationPlan` field on `specPhaseOutputSchema`. The per-ticket workflow SHALL forward `specOutput.implementationPlan` into this field on the round-0 invocation.

#### Scenario: Activity input carries the implementation plan

- **WHEN** the workflow invokes `openPullRequestActivity` after a successful round-0 coder phase
- **THEN** the input MUST include `implementationPlan` equal to `specOutput.implementationPlan`
- **AND** the input schema MUST reject calls that omit the field

#### Scenario: Plan is sourced from workflow state, not GitHub or the container

- **WHEN** the activity composes its inputs
- **THEN** the plan MUST be sourced from the workflow-supplied input
- **AND** the activity MUST NOT read the plan from the target repo's working tree, the open PR, or any other side channel

### Requirement: Activity Returns PR Number And URL

On success, the activity SHALL return an object containing the GitHub `number` and HTML `url` of the opened (or pre-existing) pull request.

#### Scenario: Successful open returns identifiers

- **WHEN** the GitHub API responds with a created pull request
- **THEN** the activity MUST return `{ number, url }` derived from the API response

### Requirement: Duplicate PR Detection Is Idempotent

When GitHub returns a `422 Validation Failed` response indicating a pull request for the same head and base already exists, the activity SHALL fetch the existing open pull request via `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&base={base}&state=open` and SHALL return its `number` and `url` as a successful result.

#### Scenario: 422 with existing PR resolves to existing PR

- **WHEN** the create call returns `422 Validation Failed` because a PR for the same head and base already exists
- **THEN** the activity MUST issue a list call filtered by `head=<owner>:<featureBranch>`, `base=<ref>`, `state=open`
- **AND** the activity MUST return `{ number, url }` of the existing pull request
- **AND** the activity MUST NOT throw

#### Scenario: 422 with no matching open PR fails non-retryably

- **WHEN** the create call returns `422` but the follow-up list call finds no matching open PR
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure`

### Requirement: Authentication And Branch Failures Are Non-Retryable

The activity SHALL classify authentication and missing-head-branch failures as non-retryable so the workflow surfaces them immediately rather than burning the retry budget.

#### Scenario: Auth failure throws GitHubAuthFailed

- **WHEN** the GitHub API responds with `401` or `403`
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure` with `type: "GitHubAuthFailed"`

#### Scenario: Missing head branch throws GitHubHeadBranchMissing

- **WHEN** the GitHub API indicates the supplied `featureBranch` does not exist on the remote
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure` with `type: "GitHubHeadBranchMissing"`

### Requirement: Transient GitHub Failures Are Retryable

Network errors and `5xx` responses from GitHub SHALL propagate as ordinary errors so Temporal's default activity retry policy reattempts the call.

#### Scenario: 5xx response is retried

- **WHEN** the GitHub API responds with a `5xx` status
- **THEN** the activity MUST throw a retryable error (not an `ApplicationFailure` marked non-retryable)
- **AND** Temporal's default activity retry policy MUST reattempt the activity

#### Scenario: Network error is retried

- **WHEN** the GitHub API call fails due to a network error
- **THEN** the activity MUST throw a retryable error (not an `ApplicationFailure` marked non-retryable)

### Requirement: GitHub Token Resolved At Activity Boundary

The system SHALL resolve `TARGET_REPO_GITHUB_TOKEN` via a config helper invoked when the activity executes, not at module load time. A missing token SHALL surface as a non-retryable `ApplicationFailure` thrown from inside the activity.

#### Scenario: Missing token surfaces as non-retryable failure

- **WHEN** the activity executes and `TARGET_REPO_GITHUB_TOKEN` is not set in the worker environment
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure`
- **AND** the worker MUST NOT crash at module load time due to the missing token

### Requirement: Post Pull Request Review Activity Exists On Orchestrator Queue

The system SHALL expose a `postPullRequestReviewActivity` registered on the orchestrator worker (the same task queue that hosts `openPullRequestActivity` and `syncLinearTicketStateActivity`), not on per-attempt container workers. The activity SHALL accept the target repo slug, the open PR number, the verdict, a top-level review body, and an array of per-file/line review comments.

#### Scenario: Activity registered on orchestrator worker

- **WHEN** the orchestrator worker boots
- **THEN** `postPullRequestReviewActivity` MUST be present in its activity registry
- **AND** the activity MUST NOT be registered on any per-attempt container worker

#### Scenario: Activity input shape

- **WHEN** the workflow invokes `postPullRequestReviewActivity`
- **THEN** the input MUST include `targetRepoSlug`, `prNumber`, `verdict`, `body`, and `comments`
- **AND** `verdict` MUST be either `"approve"` or `"changes_requested"`
- **AND** each entry of `comments` MUST be `{ path: string; line?: number; body: string }`

### Requirement: Activity Posts Comment Review Via GitHub Reviews API

The activity SHALL call `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` resolving `owner` and `repo` from the repo registry keyed by `targetRepoSlug` via the existing `loadRepoSlugRegistry()` / `findRegistryEntry()` helpers. The `event` field SHALL always be `COMMENT` in the current single-identity setup, regardless of whether the supplied semantic verdict is `"approve"` or `"changes_requested"`. The supplied `body` SHALL be passed through as the top-level review body. Per-file/line `comments[]` entries SHALL be passed through as inline review comments.

#### Scenario: Approve verdict maps to COMMENT event

- **WHEN** the activity executes with `verdict: "approve"`
- **THEN** the `event` field of the GitHub Reviews API request MUST be `COMMENT`
- **AND** the request body MUST include the supplied top-level `body`

#### Scenario: Changes-requested verdict maps to COMMENT event

- **WHEN** the activity executes with `verdict: "changes_requested"`
- **THEN** the `event` field of the GitHub Reviews API request MUST be `COMMENT`
- **AND** the request body MUST include the supplied top-level `body`

#### Scenario: Inline comments forwarded

- **WHEN** the activity executes with a non-empty `comments[]` array
- **THEN** each entry MUST be forwarded to the GitHub Reviews API as an inline review comment with its `path`, optional `line`, and `body` preserved

#### Scenario: Unknown repo slug fails non-retryably

- **WHEN** the activity executes with a `targetRepoSlug` not present in the registry
- **THEN** it MUST throw a non-retryable `ApplicationFailure`

### Requirement: Invalid Inline-Comment 422 Falls Back To Top-Level Review

When GitHub returns `422 Validation Failed` because one or more inline comments cannot be placed on the PR diff, the activity SHALL retry the call once with `comments: []` so the top-level review body still posts on the PR. This includes stale line or position errors and path-resolution errors such as `"Path could not be resolved"`. The activity SHALL log a warning identifying the dropped inline comments.

#### Scenario: Stale line numbers fall back to top-level review

- **WHEN** the initial `POST` to `/pulls/{pull_number}/reviews` returns `422` due to invalid `comments[].line`
- **THEN** the activity MUST retry once with `comments: []`
- **AND** if the retry succeeds, the activity MUST return successfully
- **AND** the activity MUST log a warning naming the dropped inline comments

#### Scenario: Unresolved comment paths fall back to top-level review

- **WHEN** the initial `POST` to `/pulls/{pull_number}/reviews` returns `422` because one or more comment paths could not be resolved
- **THEN** the activity MUST retry once with `comments: []`
- **AND** if the retry succeeds, the activity MUST return successfully
- **AND** the returned result MUST report the number of dropped inline comments

#### Scenario: 422 from other validation causes is non-retryable

- **WHEN** the initial `POST` returns `422` for a reason unrelated to placing inline comments on the PR diff
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure`

### Requirement: Auth And Missing PR Failures Are Non-Retryable

The activity SHALL classify GitHub authentication and missing-PR-number failures as non-retryable so the workflow surfaces them immediately rather than burning the retry budget.

#### Scenario: Auth failure throws GitHubAuthFailed

- **WHEN** the GitHub Reviews API responds with `401` or `403`
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure` with `type: "GitHubAuthFailed"`

#### Scenario: Missing PR throws GitHubPullRequestMissing

- **WHEN** the GitHub Reviews API responds with `404` for the supplied `prNumber`
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure` with `type: "GitHubPullRequestMissing"`

### Requirement: Transient Reviews-API Failures Are Retryable

Network errors and `5xx` responses from the GitHub Reviews API SHALL propagate as ordinary errors so Temporal's default activity retry policy reattempts the call.

#### Scenario: 5xx response is retried

- **WHEN** the GitHub Reviews API responds with a `5xx` status
- **THEN** the activity MUST throw a retryable error (not an `ApplicationFailure` marked non-retryable)
- **AND** Temporal's default activity retry policy MUST reattempt the activity

#### Scenario: Network error is retried

- **WHEN** the GitHub Reviews API call fails due to a network error
- **THEN** the activity MUST throw a retryable error (not an `ApplicationFailure` marked non-retryable)

### Requirement: Reviews-API Token Resolved At Activity Boundary

The activity SHALL resolve `TARGET_REPO_GITHUB_TOKEN` via the same config helper used by `openPullRequestActivity`, invoked when the activity executes rather than at module load time. A missing token SHALL surface as a non-retryable `ApplicationFailure` thrown from inside the activity.

#### Scenario: Missing token surfaces as non-retryable failure

- **WHEN** the activity executes and `TARGET_REPO_GITHUB_TOKEN` is not set in the worker environment
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure`
- **AND** the worker MUST NOT crash at module load time due to the missing token
