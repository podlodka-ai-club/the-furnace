## Why

A one-shot review gate that fails the workflow on `changes_requested` throws away the coder's diff and the PR that `github-adapter` already opened. When the reviewer flags fixable issues, the cheapest next step is to feed its findings back to the coder and let it iterate on the same PR — not to terminate the workflow and force a fresh ticket attempt to clean up issues that were already understood. A bounded coder ↔ reviewer feedback loop on the existing PR turns a `changes_requested` verdict into actionable iteration instead of a dead-end.

## What Changes

- Replace the `runReviewPhase` no-op with a real review activity (`runReviewAgent`) executed after the coder phase pushes a green branch and `github-adapter` opens the PR.
- Reviewer activity input: ticket metadata, coder diff summary, latest test results, PR number.
- Reviewer activity output: `{ verdict: "approve" | "changes_requested", reasoning: string, findings: Finding[] }` where `Finding` carries `{ path, line?, severity, message }`.
- On `changes_requested`: post the verdict + findings as a PR review (top-level body + file/line comments) on the existing PR, then re-enter the coder phase with `{ prNumber, reviewSummary, findings }` as additional input. The coder reads the PR review thread on the existing PR, addresses the findings, and pushes a new commit on the same feature branch. The reviewer then runs again over the new diff.
- On `approve`: post the approving review on the PR and complete the workflow.
- Bounded iteration: at most `MAX_REVIEW_ROUNDS` rounds per ticket (config; default `3`). Exceeding the cap fails the workflow with the last `changes_requested` payload preserved on the PR for human takeover.
- Persist each review verdict in `reviews` as one row per round using persona `architect` for MVP compatibility with the existing schema.

## Capabilities

### New Capabilities

- `single-review-with-feedback-loop`: A single reviewer activity emitting a stable verdict + structured findings, posting them to the PR, and gating a bounded loop back into the coder phase up to `MAX_REVIEW_ROUNDS` before terminating.

### Modified Capabilities

- `ticket-workflow`: `runReviewPhase` now drives a coder ↔ reviewer iteration loop bounded by a review-round cap, distinct from the existing per-phase activity-retry loop. The workflow shape becomes `spec → coder → review → (coder → review)* → completed | failed`.
- `github-adapter`: gains a verb to post a PR review (verdict + body + per-file/line comments) against an existing PR via the GitHub Reviews API.
- `coder-agent`: input shape gains optional `priorReview: { prNumber, findings, reviewSummary }` so the coder can fetch and address PR comments on follow-up rounds; absent on the initial round.

## Impact

- Depends on: `coder-agent`, `github-adapter`, `container-as-worker`, `data-model`.
- Modifies: the coder phase input contract (gains optional `priorReview` for follow-up rounds) and the per-ticket workflow control flow.
- New files: `server/src/agents/review/activity.ts`, `server/src/agents/review/prompt.md`.
- Schema-compatible with `data-model`: one `reviews` row per round.
- Defers advanced multi-persona fan-out and vote aggregation to Phase 6 (`persona-reviewers`, `vote-aggregator`).
