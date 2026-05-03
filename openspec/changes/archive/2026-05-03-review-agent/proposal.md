## Why

A one-shot review gate that fails the workflow on `changes_requested` throws away the coder's diff and the PR that `github-adapter` already opened. When the reviewer flags fixable issues, the cheapest next step is to feed its findings back to the coder and let it iterate on the same PR — not to terminate the workflow and force a fresh ticket attempt to clean up issues that were already understood. A bounded coder ↔ reviewer feedback loop on the existing PR turns a `changes_requested` verdict into actionable iteration instead of a dead-end.

## What Changes

- Replace the `runReviewPhase` no-op with a real review activity (`runReviewAgent`) executed after the coder phase pushes a green branch and `github-adapter` opens the PR.
- Reviewer activity input: ticket metadata, coder diff summary, latest test results, PR number. The activity also computes the PR's changed paths from the target repo default branch and includes them in the reviewer prompt so inline findings cite only files GitHub can accept.
- Reviewer activity output: `{ verdict: "approve" | "changes_requested", reasoning: string, findings: Finding[] }` where `Finding` carries `{ path, line?, severity, message }`.
- On `changes_requested`: post the verdict + findings as a PR review `COMMENT` event (top-level body + file/line comments) on the existing PR, then re-enter the coder phase with `{ prNumber, reviewSummary, findings }` as additional input. The coder receives that workflow-supplied prior review, addresses the findings, and pushes a new commit on the same feature branch. The reviewer then runs again over the new diff.
- On `approve`: post a PR review `COMMENT` event containing the approving review body and complete the workflow.
- Coder follow-up rounds reject `submit_implementation` calls that pass tests but leave the working tree identical to `HEAD`, nudging the agent to make a real feedback-addressing edit or escalate a design question.
- Bounded iteration: at most `MAX_REVIEW_ROUNDS` rounds per ticket (config; default `3`). Exceeding the cap fails the workflow with the last `changes_requested` payload preserved on the PR for human takeover.
- Review-round audit lives in Temporal workflow history (activity inputs/outputs) and on the PR (one posted review per round); no orchestrator-side DB row is written. The drop-orchestrator-db change removed the `reviews` table; a future change (`vote-aggregator` or analytics) will pick a real datastore when one is needed.

## Capabilities

### New Capabilities

- `single-review-with-feedback-loop`: A single reviewer activity emitting a stable verdict + structured findings, posting them to the PR, and gating a bounded loop back into the coder phase up to `MAX_REVIEW_ROUNDS` before terminating.

### Modified Capabilities

- `ticket-workflow`: `runReviewPhase` now drives a coder ↔ reviewer iteration loop bounded by a review-round cap, distinct from the existing per-phase activity-retry loop. The workflow shape becomes `spec → coder → review → (coder → review)* → completed | failed`.
- `github-adapter`: gains a verb to post a PR review body + per-file/line comments against an existing PR via the GitHub Reviews API. In the current single-identity setup the GitHub review event is always `COMMENT`; the semantic verdict remains in workflow state and activity input.
- `coder-agent`: input shape gains optional `priorReview: { prNumber, findings, reviewSummary }` so the coder can address review findings on follow-up rounds; absent on the initial round.

## Impact

- Depends on: `coder-agent`, `github-adapter`, `container-as-worker`, `data-model`.
- Modifies: the coder phase input contract (gains optional `priorReview` for follow-up rounds) and the per-ticket workflow control flow.
- New files: `server/src/agents/review/activity.ts`, `server/src/agents/review/prompt.md`.
- No DB persistence: round audit relies on Temporal history + GitHub-side PR reviews. Defers persistence (and multi-persona vote aggregation) to `persona-reviewers` / `vote-aggregator` in Phase 6.
