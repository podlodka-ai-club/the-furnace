## Why

For the MVP, we need a single deterministic review gate that decides whether the workflow can finish by opening a PR. Multi-persona fan-out and vote aggregation are valuable, but they add coordination complexity (parallel activities, tie-break paths, veto windows) that delays the first end-to-end ticket -> PR loop.

## What Changes

- Replace the `runReviewPhase` no-op with one review activity (`runReviewAgent`) executed after coder output is green.
- Input: ticket metadata, coder diff summary, and latest test results.
- Output: `{ verdict: "approve" | "changes_requested", reasoning: string, findings: string[] }`.
- On `approve`: proceed to PR creation via `github-adapter` and complete the workflow.
- On `changes_requested`: record the attempt outcome and fail the phase without opening a PR.
- Persist the review result in `reviews` as one row per attempt using persona `architect` for MVP compatibility with the existing schema.

## Capabilities

### New Capabilities

- `single-review`: One reviewer decision activity with a stable verdict schema gating PR creation.

### Modified Capabilities

- `ticket-workflow`: `runReviewPhase` is now a real gate that either allows PR creation or terminates with review feedback.

## Impact

- Depends on: `coder-agent`, `github-adapter`, `container-as-worker`, `data-model`.
- New files: `server/src/agents/review/activity.ts`, `server/src/agents/review/prompt.md`.
- Keeps schema compatibility with `data-model` by writing one `reviews` row per attempt.
- Defers advanced multi-persona fan-out and vote aggregation to Phase 6 (`persona-reviewers`, `vote-aggregator`).
