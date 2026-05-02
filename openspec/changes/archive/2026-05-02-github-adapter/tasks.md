## 1. Setup

- [x] 1.1 Add `@octokit/rest` to `server/package.json` and run `npm install` so the lockfile updates
- [x] 1.2 Add `readGitHubToken()` helper to `server/src/temporal/config.ts` that reads `GITHUB_TOKEN` lazily and throws a descriptive error if unset
- [x] 1.3 Add `readClaudeModel()` helper to `server/src/temporal/config.ts` that reads `CLAUDE_MODEL` lazily and returns the literal `"unknown"` if unset

## 2. GitHub Client Module

- [x] 2.1 Create `server/src/github/client.ts` exporting an Octokit factory that takes a token and returns a typed client
- [x] 2.2 Add `buildPrTitle(ticketIdentifier, ticketTitle)` that returns `${identifier}: ${title}` truncated to 72 characters with a trailing `…` when truncated
- [x] 2.3 Add `buildPrBody({ ticketDescription, diffSummary, workflowDeepLink, metadata })` that emits the ticket description, diff summary line, workflow link, and a `<!-- furnace:metadata -->` block with `Workflow-Id`, `Ticket-Id`, `Ticket-Identifier`, `Attempt-Count`, `Model`, `Final-Commit` lines
- [x] 2.4 Add `openPR(octokit, { owner, repo, base, head, title, body })` that calls `POST /repos/{owner}/{repo}/pulls` and returns `{ number, url }`
- [x] 2.5 Add `findOpenPR(octokit, { owner, repo, base, head })` that calls `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&base={base}&state=open` and returns the first matching `{ number, url }` or `null`
- [x] 2.6 Add an error classifier that maps Octokit errors to `{ kind: "auth" | "headMissing" | "duplicate" | "transient" | "other", original }` for the activity to consume

## 3. Open PR Activity

- [x] 3.1 Create `server/src/temporal/activities/github.ts` exporting `openPullRequestActivity` with the input shape `{ featureBranch, targetRepoSlug, ticket, workflowId, attemptCount, finalCommitSha, diffSummary }`
- [x] 3.2 In the activity body, resolve the registry entry via `loadRepoSlugRegistry()` + `findRegistryEntry()` and throw a non-retryable `ApplicationFailure` for unknown slugs
- [x] 3.3 Resolve the GitHub token via `readGitHubToken()` and throw a non-retryable `ApplicationFailure` when missing
- [x] 3.4 Compose title via `buildPrTitle` and body via `buildPrBody` (using `buildWorkflowDeepLink` for the workflow link and `readClaudeModel()` for the metadata `Model:` line)
- [x] 3.5 Call `openPR`; on `422` invoke `findOpenPR` and return the existing PR; throw non-retryable `ApplicationFailure` if no matching open PR is found
- [x] 3.6 Map auth errors to non-retryable `ApplicationFailure(type: "GitHubAuthFailed")` and missing-head-branch errors to non-retryable `ApplicationFailure(type: "GitHubHeadBranchMissing")`
- [x] 3.7 Let transient errors (5xx, network) propagate as ordinary errors so Temporal's default activity retry policy reattempts the call

## 4. Worker Registration

- [x] 4.1 Register `openPullRequestActivity` on the orchestrator worker registry only (the queue that already hosts `syncLinearTicketStateActivity`)
- [x] 4.2 Confirm the per-attempt container worker registry does NOT include `openPullRequestActivity`

## 5. Workflow Integration

- [x] 5.1 Extend `PerTicketWorkflowResult` in `server/src/temporal/workflows/per-ticket.ts` to add optional `pr?: { number: number; url: string }`
- [x] 5.2 After `runCoderPhase` returns green and before the existing no-op `runReviewPhase` call, invoke `openPullRequestActivity` with the coder phase output, ticket, workflow id, and attempt count
- [x] 5.3 Annotate the call site with a `TODO(review-agent)` comment describing the future move to the review approve path (gated on `reviewOutput.verdict === "approve"`)
- [x] 5.4 Build the activity's `diffSummary` from the coder phase's `diffStat` (e.g., `N files changed, +I/-D`)
- [x] 5.5 On success, populate the workflow result's `pr` field from the activity result; ensure `pr` stays absent on cancel and human-pause failure paths (`AcClarificationRequested`, `DepMissingRequested`, `DesignQuestionRequested`)

## 6. Tests

- [x] 6.1 Unit tests for `buildPrTitle` covering short title (verbatim), exactly-72-char title (verbatim), and over-72 title (truncated with `…`)
- [x] 6.2 Unit tests for `buildPrBody` asserting ticket description verbatim, diff summary line, workflow link, and the metadata block with all six required keys in order
- [x] 6.3 Unit tests for the GitHub client error classifier covering `401`, `403`, `422` (duplicate), `422` (no matching PR), branch-missing, and `5xx` cases
- [x] 6.4 Activity unit test: mocked Octokit returns a fresh PR → activity returns `{ number, url }` from the response
- [x] 6.5 Activity unit test: mocked Octokit returns `422` for create then a matching open PR for list → activity returns existing PR `{ number, url }` and does not throw
- [x] 6.6 Activity unit test: missing `GITHUB_TOKEN` → non-retryable `ApplicationFailure`
- [x] 6.7 Workflow integration test against real Temporal: coder green → workflow result includes `pr.number` and `pr.url` from a stubbed Octokit
- [x] 6.8 Workflow integration test: cancel signal between coder and review → workflow result has `status: "cancelled"` and no `pr` field; `openPullRequestActivity` was not invoked
- [x] 6.9 Workflow integration test: coder phase throws `DepMissingRequested` → `openPullRequestActivity` was not invoked

## 7. Documentation

- [x] 7.1 Document the PR-body `<!-- furnace:metadata -->` block contract (delimiters, key list, ordering) in AGENTS.md
- [x] 7.2 Document the `GITHUB_TOKEN` env var and minimum required scope (`repo` for private, `public_repo` for public) in the env-var section of AGENTS.md

## 8. Verification

- [x] 8.1 Run `TEMPORAL_TASK_QUEUE=local-test npm test` from the repo root and confirm full green
- [x] 8.2 Run `openspec validate github-adapter --strict` and confirm the change still validates
