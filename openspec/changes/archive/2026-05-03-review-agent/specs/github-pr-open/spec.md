## ADDED Requirements

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
