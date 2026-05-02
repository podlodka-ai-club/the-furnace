## Context

Phase 4 needs the workflow to actually surface its work to humans. Today, after the coder phase pushes a green branch the workflow ends silently — there is no PR. The `review-agent` change (the originally-planned predecessor of `github-adapter` per `openspec/roadmap.md`) is not yet implemented; this change therefore wires the **coder phase green path** directly to PR open as a temporary shortcut, with a clearly marked seam for `review-agent` to splice in later.

Existing facts that constrain the design:
- The orchestrator workflow lives in `server/src/temporal/workflows/per-ticket.ts`. Phase activities are dispatched via `phaseActivitiesForRepo(slug)` to **per-repo task queues** consumed by ephemeral per-attempt containers.
- The per-attempt container worker shuts down after a single activity (`worker-entry.ts` > `singleTaskActivity`); container-side activities are single-shot, fresh-container-per-retry by design (concept §3.6).
- The coder phase already commits on the feature branch with structured trailers (`Workflow-Id`, `Ticket-Id`, `Attempt`, `Phase`) and pushes via `pushExistingBranch` (`server/src/agents/shared/repo-ops.ts:300-340`). On success it returns a `CoderPhaseOutput` with `featureBranch`, `finalCommitSha`, `diffStat`, `testRunSummary`.
- Repo registry entries (`build/repos.json`) carry `owner`, `name`, `ref` (default branch). These are the GitHub PR coordinates.
- Per-ticket workflow already has a `runReviewPhase` no-op call after the coder phase. That call site is the obvious splice-point.

## Goals / Non-Goals

**Goals:**
- After the coder phase finishes green, open a GitHub PR from `featureBranch` against the repo's default `ref` and return the PR number/URL in the workflow output.
- Embed workflow traceability metadata (workflow id, ticket id, attempt count, model name) in the PR body so the PR is self-describing without relying on commit trailers being uniform.
- Make the splice-point for `review-agent` mechanical: a single activity call in `per-ticket.ts` that today fires on coder green and tomorrow fires on review approve.
- Keep the GitHub client out of the per-attempt container — the call is one HTTP round-trip and does not need the container's repo workspace.

**Non-Goals:**
- Auto-merge, label management, draft PRs, or PR templates.
- Multi-PR-per-ticket flows; one workflow → one PR.
- Veto windows, status checks, governance.
- Re-amending existing coder/spec commits to add new trailers (`appendCommitTrailers` from the proposal sketch). Per-commit trailers are already adequate; PR-body metadata closes the remaining gap. Deferred — see "Decisions".
- Rich diff rendering in the PR body. Octokit/GitHub already render the diff on the PR page.

## Decisions

### 1. Open the PR from a new orchestrator-side activity, not from the container

PR open is a single GitHub REST call. The per-attempt container exists to give the agent a clean repo workspace; we do not need a workspace to call `POST /repos/{owner}/{repo}/pulls`. Running the activity on the **default orchestrator task queue** (same queue that hosts `syncLinearTicketStateActivity`) avoids:
- Booting a container per PR open (latency, image cost).
- Plumbing `GITHUB_TOKEN` into every container image.

Activity name: `openPullRequestActivity`. Lives in `server/src/temporal/activities/github.ts` and is registered on the orchestrator worker, not the per-attempt worker.

**Alternative considered:** run the open-PR call inside the coder phase activity itself. Rejected — couples coder-phase concerns (test loop, agent budget) to delivery concerns (PR open) and makes the future review-agent splice harder.

### 2. Workflow splice-point: coder-green path with `TODO(review-agent)` marker

In `per-ticket.ts`, after `runCoderPhase` returns and before the existing `runReviewPhase` call, insert:

```ts
// TODO(review-agent): once review-agent lands, move this call onto the
// review approve path and gate it on `reviewOutput.verdict === "approve"`.
const prResult = await openPullRequestActivity({...});
```

The existing no-op `runReviewPhase` call is left in place under the TODO so the workflow shape (`spec → coder → review → completed`) and the `currentPhase` query semantics survive. When `review-agent` lands it just rewires the conditional.

**Alternative considered:** delete the `runReviewPhase` no-op now and re-add it with `review-agent`. Rejected — extra churn on the workflow signature/queries for a temporary state, and risks rebase conflicts with the in-flight `review-agent` change.

### 3. PR body carries workflow metadata; no commit amend pass

The original proposal sketched `appendCommitTrailers(commitSha, ...)` to amend commits with `Workflow-Id`, `Model`, `Ticket`, `Attempt-Count`. Three reasons to skip the amend pass for this change:
- The coder phase already writes those trailers on each commit (see `buildCommitMessageWithSubject` in `repo-ops.ts:284`). The only missing field is `Model`.
- Amending pushed commits requires a force-push, which complicates the future review-agent workflow (a reviewer comparing pre- vs. post-review SHAs would see them mutate).
- The PR body is a strictly better surface for *workflow-level* metadata (one record per workflow run, not one per commit), and Octokit emits it atomically with PR open.

Decision: render a fenced metadata block at the bottom of the PR body:

```
<!-- furnace:metadata -->
Workflow-Id: <id>
Ticket-Id: <id>
Ticket-Identifier: <FUR-123>
Attempt-Count: <n>
Model: <claude-...>
Final-Commit: <sha>
<!-- /furnace:metadata -->
```

The HTML-comment delimiters make the block machine-parseable for future automation (auto-merge, vote-aggregator) without polluting PR rendering.

### 4. Token, owner/repo, and base branch resolution

- `GITHUB_TOKEN` is read once at worker boot via a new `readGitHubToken()` helper in `server/src/temporal/config.ts`. Missing-token surfaces as a non-retryable `ApplicationFailure` at activity boundary, not at module load — consistent with existing config patterns.
- `owner`, `name`, `ref` come from the repo registry entry (`build/repos.json`) keyed by `targetRepoSlug`. The activity calls `loadRepoSlugRegistry()` + `findRegistryEntry()` (already exported from `repo-registry.ts`).
- The PR title is `${ticket.identifier}: ${ticket.title}`. Truncated to 72 chars with `…` if needed (GitHub allows 256, but short titles read better in lists).
- The PR body contains: ticket description (verbatim, from Linear), a one-line diff summary (`N files changed, +I/-D`), a link to the Temporal workflow (reusing `buildWorkflowDeepLink` from coder activity), and the metadata block above.

### 5. Failure handling

PR open is **idempotent on the API call but not on the side effect**: GitHub returns `422 Validation Failed` if a PR for the same head/base already exists. The activity treats that as success — it fetches the existing PR via `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&base={base}&state=open` and returns it. This survives workflow replays where the activity completes, the workflow event is recorded, but a worker crash before the result is persisted forces a retry.

Other failures:
- Auth failure (`401`/`403`): non-retryable `ApplicationFailure(type: "GitHubAuthFailed")`.
- Network/`5xx`: retryable; default activity retry policy (3 attempts) suffices.
- Branch not found on remote: non-retryable `ApplicationFailure(type: "GitHubHeadBranchMissing")` — indicates coder push didn't actually land; the workflow surfaces it without retrying.

### 6. Workflow output shape

Extend `PerTicketWorkflowResult` from `{ status: "succeeded" | "cancelled" }` to:

```ts
{
  status: "succeeded" | "cancelled";
  pr?: { number: number; url: string };
}
```

The `pr` field is present iff `status === "succeeded"`. Downstream consumers (Slack notifications, vote aggregator) read it directly from the workflow result. Adding the optional field is backwards-compatible with existing tests that destructure `status`.

## Risks / Trade-offs

- **No quality gate during the temporary period.** Every coder-green run opens a real PR. → Mitigation: only enable on a curated demo ticket queue until `review-agent` lands; the merge step stays human-driven so a bad PR is at most noise, not a regression.
- **Force-push during retries.** The coder phase already pushes the branch; if PR open fails after the push, retries reuse the existing branch. The duplicate-PR detection (Decision 5) handles this. → Mitigation: covered by the `422 → fetch existing` path.
- **`GITHUB_TOKEN` blast radius.** A repo-scoped PAT can also push commits, close PRs, etc. → Mitigation: document the minimum scope (`repo` for private, `public_repo` for public) in the env-var section of AGENTS.md when the change lands; treat as deployment concern, not code concern.
- **PR-body metadata block is not a stable contract yet.** Vote-aggregator and auto-merge will need to parse it. → Mitigation: the HTML-comment delimiters and key:value lines are designed for grep-friendly parsing; documenting the contract in AGENTS.md is part of the ship checklist (already in proposal Impact).
- **Octokit dependency footprint.** `@octokit/rest` pulls a fair amount of transitive code into the orchestrator bundle. → Accepted; the orchestrator runs server-side, bundle size is not a constraint, and Octokit is the maintained, typed choice.
