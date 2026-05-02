## Why

The GitHub adapter is the final MVP step that exposes agent work to the rest of the engineering org. For now, finishing the workflow means opening a PR with traceable metadata; auto-merge and veto/tiebreak governance are deferred to later phases.

## What Changes

- Add `@octokit/rest` dependency.
- Add `server/src/github/client.ts` with:
  - `openPR(branch, ticket, diffSummary)` — opens a PR and returns the PR number.
  - `appendCommitTrailers(commitSha, trailers)` — amends commits on the branch to include `Workflow-Id:`, `Model:`, `Ticket:`, `Attempt-Count:` trailers (one amend pass after the coder phase finishes green, before PR open; later moves to post-review).
- Temporarily wire the **coder phase green path** directly to `openPR` and complete the workflow as `pr-opened`. The `review-agent` change will later replace this hop with a review gate; mark the integration point with a `TODO(review-agent)` comment so the swap is mechanical.
- Do not implement merge automation in this change; merging stays human-driven in MVP.

## Capabilities

### New Capabilities

- `github-pr-open`: PR creation with structured commit trailers as the workflow completion event.

### Modified Capabilities

- `ticket-workflow`: a green coder phase now ends with a created PR URL/number attached to workflow output (interim wiring; will gate on review once `review-agent` lands).

## Impact

- New dep: `@octokit/rest`.
- New files: `server/src/github/client.ts`, `server/src/github/trailers.ts`.
- New env vars: `GITHUB_TOKEN` (with repo-scoped read/write for branch + PR creation).
- Depends on: `coder-agent` for the temporary direct wiring (was: `review-agent`). The `review-agent` change will reroute the approve path through this adapter once it lands.
- Reads workflow metadata for trailers (workflow id, model, ticket id, attempt count) from Temporal workflow state — no DB layer needed.
- Commit trailer shape is the public contract; document it in AGENTS.md once landed.
