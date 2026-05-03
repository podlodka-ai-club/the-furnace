## 1. Contracts and Configuration

- [x] 1.1 Extend `reviewResultSchema` in `server/src/agents/contracts/reviewer-io.ts` to promote `findings` from `string[]` to `Finding[]` (`{ path: string; line?: number; severity: "blocking" | "advisory"; message: string }`); export the `Finding` type and `findingSchema`.
- [x] 1.2 Update the existing `runReviewPhase` no-op stub in `server/src/temporal/activities/phases.ts` so its placeholder return value satisfies the new `Finding[]` shape; fix any unit tests that hand-build `ReviewResult` placeholders.
- [x] 1.3 Extend `coderPhaseInputSchema` in `server/src/agents/contracts/coder-io.ts` (or wherever it is currently defined) with an optional `priorReview: { prNumber: number; reviewSummary: string; findings: Finding[] }` field; reuse the `Finding` schema from 1.1.
- [x] 1.4 Add a `MAX_REVIEW_ROUNDS` constant (default `3`) in `server/src/temporal/dispatch.ts` next to `PHASE_MAX_ATTEMPTS`; export it for workflow consumption.
- [x] 1.5 Define the reviewer activity input schema (`ticket`, `featureBranch`, `finalCommitSha`, `diffStat`, `testSummary`, `prNumber`, `round`) in `server/src/agents/contracts/reviewer-io.ts`; export the parser used by the activity boundary.

## 2. Reviewer Activity

- [x] 2.1 Create `server/src/agents/review/prompt.md` with the reviewer system prompt: instruct the agent to read changed files, ground findings in the current SHA, emit a verdict + structured findings, classify each as `blocking` or `advisory`, and trust the supplied `testSummary` (no test re-run).
- [x] 2.2 Implement `runReviewAgent` in `server/src/agents/review/activity.ts`: read prompt at activity entry via `fs.readFile`, instantiate the SDK conversation against the in-container working tree, parse output via `reviewResultSchema.parse()`, throw on schema failure.
- [x] 2.3 Wire `Context.heartbeat()` at activity start and a `setInterval` heartbeat every 5s during the SDK conversation; clear the interval in a `finally` block.
- [x] 2.4 Register `runReviewAgent` as the implementation of `runReviewPhase` on the per-repo container task queue in `server/src/temporal/activities/phases.ts`; ensure it is NOT registered on the orchestrator worker.

## 3. Pull Request Review Posting Activity

- [x] 3.1 Add `postPullRequestReviewActivity` in `server/src/temporal/activities/github.ts` accepting `{ targetRepoSlug, prNumber, verdict, body, comments: { path; line?; body }[] }`.
- [x] 3.2 Resolve `owner`/`repo` via `loadRepoSlugRegistry()` / `findRegistryEntry()`; resolve `TARGET_REPO_GITHUB_TOKEN` via the same lazy config helper used by `openPullRequestActivity`; throw non-retryable `ApplicationFailure` on missing token or unknown slug.
- [x] 3.3 Call `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with `event: APPROVE` (verdict approve) or `event: REQUEST_CHANGES` (verdict changes_requested); forward `comments[]` as inline review comments preserving `path`, optional `line`, and `body`.
- [x] 3.4 Implement the 422-stale-line fallback: detect 422 caused by `comments[].line` not in diff, retry once with `comments: []`, log a warning naming the dropped comments; classify other 422s as non-retryable.
- [x] 3.5 Classify error responses: 401/403 → non-retryable `ApplicationFailure` `type: "GitHubAuthFailed"`; 404 on the supplied `prNumber` → non-retryable `type: "GitHubPullRequestMissing"`; 5xx and network errors → retryable.
- [x] 3.6 Register `postPullRequestReviewActivity` on the orchestrator worker only; ensure it is NOT registered on per-attempt container workers.

## 4. Coder Activity Updates

- [x] 4.1 In the coder activity body (`server/src/agents/coder/activity.ts` or equivalent), branch on `input.priorReview`: when present, augment the SDK prompt with `priorReview.reviewSummary` verbatim and a list of each finding's `path`, `line`, `severity`, `message`; instruct the agent to address findings while keeping spec tests green.
- [x] 4.2 Confirm the coder activity issues no `api.github.com` requests on any round and that the per-attempt container does not carry a GitHub-scoped credential; remove any code path that would fetch PR review comments from the container.
- [x] 4.3 Update or add unit tests asserting prompt content differs across round 0 (no prior-review section) and follow-up rounds (prior-review section present with all findings).

## 5. Workflow Round Loop

- [x] 5.1 In `server/src/temporal/workflows/per-ticket.ts`, introduce a `round` workflow-local counter and an outer loop wrapping `runCoderPhase` and `runReviewPhase` for `round in 0..MAX_REVIEW_ROUNDS-1`.
- [x] 5.2 Keep `openPullRequestActivity` invoked exactly once after the round-0 coder phase, before the first `runReviewPhase`; reuse the returned `prNumber` across all subsequent rounds.
- [x] 5.3 Construct the reviewer activity input each round with `ticket`, coder phase outputs (`featureBranch`, `finalCommitSha`, `diffStat`, `testSummary`), the round-0 `prNumber`, and the current `round` index.
- [x] 5.4 After each `runReviewPhase`, invoke `postPullRequestReviewActivity` (for both verdicts) with the verdict, `reasoning` as the top-level body, and findings translated into per-file/line review comments.
- [x] 5.5 On `verdict: "approve"`, break the loop and complete with `status: "succeeded"`.
- [x] 5.6 On `verdict: "changes_requested"` with rounds remaining, populate `priorReview: { prNumber, reviewSummary: reasoning, findings }` and continue to the next round's `runCoderPhase`.
- [x] 5.7 On loop exit due to cap exhaustion, throw `ApplicationFailure.nonRetryable` of type `ReviewRoundCapExhausted` carrying the last verdict, reasoning, and findings as failure detail; do not change the Linear ticket state from `In Progress`.
- [x] 5.8 Add a `cancelled` check at the top of each round iteration so a cancel arriving between `postPullRequestReviewActivity` and the next `runCoderPhase` transitions the workflow to the cancelled terminal state without launching another phase.
- [x] 5.9 Register a Temporal query handler `currentRound` returning the in-memory zero-based round index alongside the existing `currentPhase` and `attemptCount` queries.

## 6. Tests

- [x] 6.1 Unit tests for `reviewResultSchema`: valid `approve` (advisory-only findings allowed), valid `changes_requested` (≥1 blocking finding required by spec wording), invalid shapes rejected.
- [x] 6.2 Unit tests for `coderPhaseInputSchema`: round-0 input without `priorReview` parses; follow-up input with `priorReview` parses; malformed `priorReview` rejected.
- [x] 6.3 Unit tests for `postPullRequestReviewActivity`: verdict mapping (`approve` → `APPROVE`, `changes_requested` → `REQUEST_CHANGES`); comment forwarding; 422-stale-line fallback path; 401/403/404/5xx classification; missing token; unknown slug.
- [x] 6.4 Integration test (real Temporal per `CLAUDE.md`) for the round loop happy path: round 0 coder green → PR opened → review approve → workflow succeeded; assert `openPullRequestActivity` called exactly once and `postPullRequestReviewActivity` called once with `event: APPROVE`.
- [x] 6.5 Integration test for the iterate path: round 0 review `changes_requested` → coder re-invoked with `priorReview` populated → round 1 review `approve` → workflow succeeded; assert exactly two `runReviewPhase` invocations with `round` 0 and 1 in their inputs, and the existing PR is reused (no second `openPullRequestActivity` call).
- [x] 6.6 Integration test for cap exhaustion: configure `MAX_REVIEW_ROUNDS = 2`, force `changes_requested` on every round; assert `ReviewRoundCapExhausted` non-retryable failure carrying the last review payload, PR remains open, ticket remains `In Progress`, exactly two `runReviewPhase` invocations observed.
- [x] 6.7 Integration test for cancel between rounds: signal `cancel` after a `changes_requested` post and before the next coder dispatch; assert no further `runCoderPhase` or `runReviewPhase` invocations and the workflow reaches the cancelled terminal state.

## 7. Verification

- [x] 7.1 Run `TEMPORAL_TASK_QUEUE=local-test npm test` from the repo root; resolve any failures.
- [x] 7.2 Update `openspec/roadmap.md` if this change graduates the review phase from Phase 5 stub to real implementation.
- [x] 7.3 `openspec validate review-agent --strict` passes with zero issues.
