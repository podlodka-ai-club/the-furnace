## ADDED Requirements

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

The pull request body SHALL include, in order: the ticket description verbatim, a one-line diff summary derived from the supplied `diffSummary`, a link to the Temporal workflow execution, and a fenced metadata block delimited by `<!-- furnace:metadata -->` and `<!-- /furnace:metadata -->` HTML comments.

The metadata block SHALL contain one `Key: Value` line per field, with the keys `Workflow-Id`, `Ticket-Id`, `Ticket-Identifier`, `Attempt-Count`, `Model`, and `Final-Commit`.

#### Scenario: Body includes ticket description and diff summary

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain the ticket description verbatim
- **AND** the body MUST contain a one-line diff summary derived from the supplied `diffSummary`

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

The system SHALL resolve `GITHUB_TOKEN` via a config helper invoked when the activity executes, not at module load time. A missing token SHALL surface as a non-retryable `ApplicationFailure` thrown from inside the activity.

#### Scenario: Missing token surfaces as non-retryable failure

- **WHEN** the activity executes and `GITHUB_TOKEN` is not set in the worker environment
- **THEN** the activity MUST throw a non-retryable `ApplicationFailure`
- **AND** the worker MUST NOT crash at module load time due to the missing token
