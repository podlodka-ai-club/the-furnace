## Why

The GitHub adapter is the final MVP step that exposes agent work to the rest of the engineering org. For now, finishing the workflow means opening a PR with traceable metadata; auto-merge and veto/tiebreak governance are deferred to later phases.

## What Changes

- Add `@octokit/rest` dependency.
- Add `server/src/github/client.ts` with:
  - `openPR(branch, ticket, diffSummary)` — opens a PR and returns the PR number.
  - `appendCommitTrailers(commitSha, trailers)` — amends commits on the branch to include `Workflow-Id:`, `Model:`, `Ticket:`, `Attempt-Count:` trailers (one amend pass after review-green, before PR open).
- Wire the `review-agent` approve path to call `openPR` and complete the workflow as `pr-opened`.
- Do not implement merge automation in this change; merging stays human-driven in MVP.

## Capabilities

### New Capabilities

- `github-pr-open`: PR creation with structured commit trailers as the workflow completion event.

### Modified Capabilities

- `ticket-workflow`: successful review now ends with a created PR URL/number attached to workflow output.

## Impact

- New dep: `@octokit/rest`.
- New files: `server/src/github/client.ts`, `server/src/github/trailers.ts`.
- New env vars: `GITHUB_TOKEN` (with repo-scoped read/write for branch + PR creation).
- Depends on: `review-agent`, `data-model` (reads workflow metadata for trailers).
- Commit trailer shape is the public contract; document it in AGENTS.md once landed.
