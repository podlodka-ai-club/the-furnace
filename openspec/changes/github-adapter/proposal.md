## Why

The GitHub adapter is the final step that exposes agent work to the rest of the engineering org. Concept §2 requires structured commit trailers (workflow-id, model, ticket, attempt-count) so every merged commit is traceable back to the Temporal workflow that produced it, enabling deterministic replay and post-hoc audit.

## What Changes

- Add `@octokit/rest` dependency.
- Add `server/src/github/client.ts` with:
  - `openPR(branch, ticket, diffSummary)` — opens a PR and returns the PR number.
  - `appendCommitTrailers(commitSha, trailers)` — amends commits on the branch to include `Workflow-Id:`, `Model:`, `Ticket:`, `Attempt-Count:` trailers (one amend pass after review-green, before PR open).
  - `mergePR(prNumber)` — squash-merge used by the auto-merge path after the veto window.
- Wire the `vote-aggregator`'s auto-merge path to call `openPR` → wait for window → call `mergePR` unless `vetoOverride` fired.
- On human-tiebreak path: `openPR` still runs (PR is visible for review) but `mergePR` is gated on the `approveMergeVeto` signal.

## Capabilities

### New Capabilities

- `github-pr-lifecycle`: PR open with structured commit trailers, auto-merge after veto window, and signal-gated merge for human-tiebreak path.

### Modified Capabilities

- `vote-aggregation`: Its auto-merge and human-tiebreak outcomes now invoke real GitHub operations.

## Impact

- New dep: `@octokit/rest`.
- New files: `server/src/github/client.ts`, `server/src/github/trailers.ts`.
- New env vars: `GITHUB_TOKEN` (with repo-scoped write + PR-merge permission).
- Depends on: `vote-aggregator`, `data-model` (reads workflow metadata for trailers).
- Commit trailer shape is the public contract; document it in AGENTS.md once landed.
