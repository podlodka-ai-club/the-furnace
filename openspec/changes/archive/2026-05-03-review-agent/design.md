## Context

The per-ticket workflow today executes `spec → coder → openPR → runReviewPhase(no-op) → completed` (see [per-ticket.ts:120-183](server/src/temporal/workflows/per-ticket.ts#L120-L183)). The `runReviewPhase` activity already exists as a no-op stub returning a `ReviewResult` placeholder; `openPullRequestActivity` already runs **before** the review phase, so by the time review executes a real PR exists at a known `{ number, url }`. The proposal builds on that: replace the no-op with a real reviewer, post its verdict to the existing PR, and on `changes_requested` route control back to the coder phase with the findings so the agent can iterate on the same PR.

Constraints carried over from existing specs:
- Phase activities run on per-attempt container task queues (`phaseActivitiesForRepo(slug)`) and the container worker shuts down after one activity (concept §3.6, [container-worker-lifecycle](openspec/specs/container-worker-lifecycle/spec.md)). Each loop round therefore consumes its own fresh container for both the coder and the reviewer.
- Workflow-level retry orchestration lives in `runPhase()` ([per-ticket.ts:201-246](server/src/temporal/workflows/per-ticket.ts#L201-L246)) because activity-level retries would re-queue onto a dead worker. The new round-loop must compose with — not replace — that mechanism.
- `ReviewResult` is already a typed contract ([reviewer-io.ts](server/src/agents/contracts/reviewer-io.ts)) with `findings: string[]`. Promoting findings to structured `Finding` objects is a contract change that ripples through the no-op stub and any tests using `reviewResultSchema`.
- Coder activity input is `{ ticket, specOutput }` ([code-generation/spec.md:83-91](openspec/specs/code-generation/spec.md#L83-L91)). Adding `priorReview` is an additive optional field; absent on round 0.

## Goals / Non-Goals

**Goals:**
- One reviewer activity emits a deterministic verdict (`approve` | `changes_requested`) plus structured, file/line-scoped findings.
- The verdict is mirrored to the existing PR via the GitHub Reviews API so it is visible to humans and to the coder agent on follow-up rounds.
- On `changes_requested`, the workflow re-enters the coder phase with the prior review attached, bounded to `MAX_REVIEW_ROUNDS` total rounds (default 3).
- Failure on cap exhaustion preserves the last review on the PR and surfaces a non-retryable workflow failure for human takeover.
- Round audit relies on Temporal workflow history (activity inputs/outputs) and on the PR (one posted review per round); no orchestrator-side persistence is added in this change.

**Non-Goals:**
- Multi-persona fan-out, vote aggregation, tie-break logic — deferred to `persona-reviewers` / `vote-aggregator`.
- Auto-merge on approve — `auto-merge` change owns that.
- Slack signaling on `changes_requested` — `slack-notifications` change owns that.
- Draft PR semantics. The PR is opened in round 0 by `github-adapter` and stays in its existing state; we do not introduce draft/ready transitions in this change.
- Re-opening a closed PR if a human closes it mid-loop — out of scope; treat as cancellation analog (deferred).

## Decisions

### D1: Reviewer activity runs on the per-attempt container queue

Register `runReviewAgent` as the implementation of `runReviewPhase` on the per-repo container task queue (same dispatch as `runSpecPhase` / `runCoderPhase`). The reviewer needs the repo workspace to read actual file contents around finding locations and to run lightweight static checks; a diff blob alone is not enough context. This also keeps the rate-limit/budget surface uniform across phase agents.

**Alternative considered:** run on the orchestrator queue like `openPullRequestActivity`, passing only the diff text. Rejected — narrows the reviewer's tool surface to whatever we hand-roll and forces a second round-trip whenever the agent wants to read a file the diff didn't show.

### D2: Posting the review to the PR runs on the orchestrator queue as COMMENT

Add a new orchestrator-side activity `postPullRequestReviewActivity` next to `openPullRequestActivity` in [server/src/temporal/activities/github.ts](server/src/temporal/activities/github.ts). Inputs: `{ targetRepoSlug, prNumber, verdict, body, comments: ReviewComment[] }`. It calls `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with `event: COMMENT` and per-file/line `comments[]`. Idempotency: if the review POST fails 5xx, default retry; if 422 indicates an invalid inline comment, fall back to a top-level review with no inline comments and warn.

Because the MVP uses the same GitHub PAT to open the PR and post the review, GitHub rejects semantic review events (`APPROVE` / `REQUEST_CHANGES`) on the actor's own PR. The activity therefore always sends GitHub `event: COMMENT`; the semantic verdict remains explicit in workflow state and activity input/output. `ReviewEvent` is narrowed to `"COMMENT"` until a future multi-identity reviewer setup exists.

If GitHub rejects inline comments because a line or path cannot be resolved against the PR diff, the activity retries once with `comments: []` so the top-level review body still posts. Other 422 validation failures remain non-retryable.

**Alternative considered:** have the reviewer agent post its own review from inside the container via the GitHub token. Rejected — keeps GitHub auth out of per-attempt containers (consistent with `openPullRequestActivity`'s placement) and centralizes PR-side mutation on the orchestrator.

**Alternative considered:** map `approve` to `APPROVE` and `changes_requested` to `REQUEST_CHANGES`, then fall back to `COMMENT` only after GitHub rejects self-review. Rejected — it makes the common single-identity path pay an avoidable failed API call every round, and downstream logic already uses the workflow verdict rather than GitHub's review event.

### D3: Workflow round loop wraps `coder + review`, distinct from `runPhase` retries

Introduce a new outer loop in `perTicketWorkflow`:

```
spec → openPR → for round in 0..MAX_REVIEW_ROUNDS-1:
                  coder(round) → review(round)
                  if approve: break → completed
                else: continue
              else: fail (cap exhausted)
```

Each `coder(round)` and `review(round)` call still goes through `runPhase()`, so the existing per-phase activity-retry budget (`PHASE_MAX_ATTEMPTS`) and stuck-failure semantics are unchanged. The round counter is a workflow-local variable; `attemptCount` continues to count phase activity launches (now monotonically increasing across rounds), preserving the existing `attemptCount` query semantics.

`MAX_REVIEW_ROUNDS` lives next to `PHASE_MAX_ATTEMPTS` in [server/src/temporal/dispatch.ts](server/src/temporal/dispatch.ts), default `3`.

**Alternative considered:** model the loop as recursive workflow continuation (`continueAsNew`). Rejected — overkill for ≤3 rounds; loses query history; complicates the `pr` field semantics.

### D4: PR opens once, in round 0, and is reused across rounds

Keep the `openPullRequestActivity` call where it is today: after the first successful coder phase, before the first review. On follow-up rounds the coder pushes additional commits to the same `featureBranch`; the PR auto-tracks them. We do **not** re-open the PR per round. The existing 422-duplicate-detection path in `openPullRequestActivity` is dead code on the happy path but kept as defense.

**Alternative considered:** open PR after first approve. Rejected — contradicts the user requirement that the coder iterate against the *existing* PR. Without a PR in round 0 there is no surface for the reviewer to attach inline comments the coder can read.

### D5: Findings shape becomes structured; coder reads them via input, not via PR fetch

Promote `ReviewResult.findings` from `string[]` to:

```ts
type Finding = { path: string; line?: number; severity: "blocking" | "advisory"; message: string };
```

The coder phase input gains:

```ts
priorReview?: { prNumber: number; reviewSummary: string; findings: Finding[] };
```

The coder agent receives `findings` directly in its prompt; it does **not** need to call the GitHub API from inside the container. The PR review post (D2) is for human visibility and audit, not for coder input. This keeps the container boundary narrow (no GitHub token, no rate-limit surface) and makes the loop deterministic from workflow state alone.

`reviewResultSchema` ([reviewer-io.ts:21-25](server/src/agents/contracts/reviewer-io.ts#L21-L25)) gains a structured `findings` array; the existing no-op review stub and any tests that build `ReviewResult` placeholders update accordingly.

**Alternative considered:** keep `findings: string[]`, encode location in the message. Rejected — defeats inline PR comments (D2) and forces the coder to parse free-form strings.

### D6: Linear state transitions follow the loop terminus, not each round

The ticket stays in `In Progress` for every round (initial set on workflow entry, [per-ticket.ts:124-127](server/src/temporal/workflows/per-ticket.ts#L124-L127)). Only the terminal verdict drives a state change:
- terminal `approve` → `Done` (current behavior).
- cap exhaustion → ticket stays `In Progress`, workflow throws non-retryable `ApplicationFailure` of type `ReviewRoundCapExhausted`. This mirrors the `DepMissingRequested` / `DesignQuestionRequested` "human-pause" pattern: the PR is the artifact a human picks up, identical in spirit to a Linear sub-ticket.

### D7: No DB persistence — audit via Temporal history + posted PR reviews

The `drop-orchestrator-db` change deleted the `reviews` table and the entire orchestrator DB. Each round's verdict, reasoning, and findings are durable in two places already:

1. **Temporal workflow history** captures `runReviewPhase` activity inputs/outputs across crashes — the same durability property the deleted DB row was meant to provide.
2. **The PR itself** carries one posted review per round (D2), giving humans an authoritative audit trail without leaving GitHub.

A future change (`vote-aggregator` for cross-persona aggregation, or a dedicated analytics store) will pick a real datastore when there is a consumer that cannot be served by Temporal history or PR reviews. Adding storage now would inherit the same in-process WASM DB the recent incident removed.

### D8: Reviewer prompt receives authoritative PR changed paths

After checking out the feature branch, `runReviewAgent` resolves the default branch from `origin/HEAD` (falling back to `main` / `master`) and computes the PR path set with `git diff --name-only origin/<defaultBranch>...HEAD`. That list is rendered into the review prompt before the SDK conversation starts.

Reviewer findings must use only paths from this list. Concerns about unchanged files, deleted paths, or files that should have been modified belong in `reasoning` rather than `findings[]`, because GitHub rejects inline comments whose path is not part of the PR diff. This keeps the structured findings usable for GitHub comments while still preserving broader review reasoning.

### D9: Coder submit path rejects empty working-tree diffs

After a `submit_implementation` call passes the protected-test-file check and test verification, the coder activity checks `git status --porcelain` before committing. If the working tree is identical to `HEAD`, the activity sends a corrective message within the same SDK conversation instead of letting `git commit` fail with "nothing to commit".

The correction shares the existing correction budget used for prose-only responses, failing tests, and protected test-file edits. On follow-up rounds, the corrective message includes the prior review summary or blocking findings so the agent knows which feedback still needs a real code change. If the agent believes no code change is needed, it should escalate via `report_design_question`.

## Risks / Trade-offs

- **Reviewer oscillation (loop never converges)** → bounded by `MAX_REVIEW_ROUNDS=3`; on cap exhaustion the workflow fails non-retryably and the PR carries the last review for human takeover. Worth a metric in observability later.
- **Reviewer's structured findings disagree with what the coder can act on** (e.g., line numbers shift after a fixup commit) → severity `blocking` vs `advisory` lets the coder prioritize; line numbers are a hint, not a contract. The coder prompt frames findings as "issues to address," not "patches to apply at line N."
- **Each round consumes 2 fresh containers (coder + review)** → 3 rounds = up to 6 containers per ticket. Acceptable given concept §3.6 ephemerality. Future optimization: skip the final review-only run if the coder agent self-reports zero remaining findings (out of scope here).
- **Contract change to `findings`** ripples through the no-op stub, snapshot tests, and any in-flight changes that import `reviewResultSchema`. Mitigation: bump the schema in one PR alongside this change; no on-the-wire compatibility concerns since no prior data uses it.
- **PR Review API 422 on invalid inline comments** → fall back to a top-level `COMMENT` review with no inline comments (D2 mitigation); log a warning so we can tune changed-path prompting and line grounding.
- **Cancellation mid-loop** → existing `cancelSignal` is checked at every `runPhase` boundary; the round loop must check it between rounds too, otherwise a cancel arriving between approve-eval and the next coder dispatch could miss its window. The implementation must add a `cancelled` check at the top of each round iteration.
- **Round counter drift across replays** → it is a deterministic workflow-local counter, identical to `attemptCount`; safe.

## Migration Plan

Code-only change; no data migration.

1. Land `reviewResultSchema` extension (string[] → Finding[]) in [reviewer-io.ts](server/src/agents/contracts/reviewer-io.ts) and update the no-op stub in [phases.ts](server/src/temporal/activities/phases.ts) to satisfy the new shape.
2. Add `MAX_REVIEW_ROUNDS` to [dispatch.ts](server/src/temporal/dispatch.ts).
3. Implement `runReviewAgent` in `server/src/agents/review/activity.ts` (wires SDK + new prompt) and register it as the `runReviewPhase` implementation in [phases.ts](server/src/temporal/activities/phases.ts).
4. Add changed-path computation to the reviewer activity and render the path list into the prompt before the SDK conversation starts.
5. Add `postPullRequestReviewActivity` in [github.ts](server/src/temporal/activities/github.ts), always posting GitHub `COMMENT` events while preserving the semantic verdict in workflow state and activity input/output.
6. Extend coder-phase input contract with optional `priorReview`, pipe it into the coder prompt, and reject empty-diff submissions before commit.
7. Rewrite the workflow body in [per-ticket.ts](server/src/temporal/workflows/per-ticket.ts) to wrap `coder + review` in the round loop, post the review, gate on verdict, and surface `ReviewRoundCapExhausted` on cap.

Rollback: revert the workflow change; the no-op review stub still satisfies `reviewResultSchema` (post-extension) so the older shape remains valid.

## Open Questions

- **Q1: Should the reviewer agent receive the running test-run summary from the coder phase verbatim, or re-run tests itself?** Leaning verbatim (coder activity already verifies green per [code-generation/spec.md:75-95](openspec/specs/code-generation/spec.md#L75-L95)); re-running is cost/time without a clear signal. Confirm before tasks.
- **Q2: On cap exhaustion, do we also un-assign the agent in Linear or leave the assignee untouched?** Current stuck-failure paths leave the ticket `In Progress` with no assignee change — preserve that consistency unless product disagrees.
- **Q3: Persona name in `reviews` rows.** Proposal pins `architect` for MVP compatibility. Verify `data-model` schema actually accepts that literal (vs an enum that may need extension).
- **Q4: Is there a per-round timeout?** Workflow-level cap is round count, not wall-clock. Default Temporal activity timeouts cover individual phases; consider a workflow-wide deadline in observability if real runs trend long.
