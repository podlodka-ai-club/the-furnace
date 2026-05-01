## Context

The `coder-agent` change replaces the current `runCoderPhase` no-op with an implementation loop that turns failing tests from the spec phase into a green commit on the same feature branch. The worker runs in an ephemeral container per attempt, and each attempt writes a durable `attempts` row so workflow progress and failure modes are auditable.

The proposal introduces two explicit stuck classes (`dep-missing`, `design-question`) that must escalate through typed Linear sub-tickets and stop retries. This phase sits between spec generation and review, so it must produce a reviewable diff manifest on success and machine-readable failure outcomes on terminal failure.

## Goals / Non-Goals

**Goals:**
- Implement a deterministic coder-phase activity that checks out the spec branch, iterates on code changes, runs tests, and commits only when tests pass.
- Enforce bounded attempts with Temporal retry semantics and per-attempt environment reset.
- Persist each attempt outcome (`tests-green`, `retry`, `dep-missing`, `design-question`) to support observability and review.
- Emit a final diff manifest for downstream review when green.
- Escalate persistent stuck conditions into typed Linear sub-tickets with workflow deep-link context.

**Non-Goals:**
- Redesigning spec-agent output format or branch naming conventions.
- Introducing a new test execution framework beyond current repo test commands.
- Expanding stuck classification beyond the two proposal-defined categories.
- Changing review-agent behavior beyond consuming coder output contract.

## Decisions

### 1) Implement coder loop as a dedicated activity module

Decision: Create `server/src/agents/coder/activity.ts` as the integration boundary for Temporal activity execution, SDK calls, test runs, commit creation, and persistence hooks.

Rationale:
- Keeps orchestration concerns local to one module with a clear input/output contract.
- Aligns with existing phase-based architecture and eases testing of coder logic in isolation.

Alternatives considered:
- Embedding logic directly in workflow code: rejected due to poor separation and testability.
- Reusing spec-agent activity module with mode flags: rejected to avoid coupling distinct phase responsibilities.

### 2) Use fresh ephemeral container per retry attempt

Decision: Treat each retry as a cold-start from a pre-warmed base container and re-checkout target branch before running coder steps.

Rationale:
- Prevents cross-attempt contamination from transient files, partial edits, or cached state.
- Matches proposal requirement and supports reproducible failure diagnosis.

Alternatives considered:
- Reusing the same workspace across retries: rejected due to state leakage risks.
- Full image rebuild per retry: rejected as too slow relative to pre-warmed container strategy.

### 3) Classify outcomes explicitly and persist per-attempt records

Decision: Map each loop attempt to one of four canonical outcomes and write an `attempts` row immediately after each attempt concludes.

Rationale:
- Gives deterministic state transitions for workflow and reporting.
- Enables analytics on retry pressure and stuck causes.

Alternatives considered:
- Persisting only final result: rejected because intermediate retries are required for auditability.
- Free-form text status values: rejected to preserve strict downstream handling.

### 4) Stuck escalation opens typed Linear sub-ticket and fails non-retryable

Decision: When coder determines persistent `dep-missing` or `design-question`, create corresponding sub-ticket payload (including workflow deep-link) and throw non-retryable activity error.

Rationale:
- Stops wasted retries once blocker type is known.
- Produces actionable handoff artifacts for humans without losing workflow context.

Alternatives considered:
- Continue retrying after opening ticket: rejected as duplicated cost without likely progress.
- Generic "stuck" ticket type: rejected because downstream triage requires explicit category.

### 5) Output a diff manifest contract for review phase

Decision: On `tests-green`, capture committed diff metadata and return a stable manifest object consumed by `ticket-workflow` review phase.

Rationale:
- Decouples review from coder internals while preserving exact change scope.
- Supports deterministic review-agent inputs.

Alternatives considered:
- Passing raw git patch string only: rejected because structured metadata is easier to validate and evolve.

## Risks / Trade-offs

- [False stuck classification] -> Add conservative classifier thresholds, include evidence snippets in ticket payload, and default uncertain cases to retry until budget exhausts.
- [Flaky tests consume attempt budget] -> Persist failure signatures per attempt and include rerun hints; tune default budget via env without code changes.
- [Commit on unintended branch state] -> Enforce explicit branch checkout verification before edits and before commit.
- [Long-running retries increase queue pressure] -> Bound attempts (default 3) and keep non-retryable exits for known blockers.
- [Diff manifest drift from actual commit] -> Build manifest directly from committed SHA and validate file list generation step.

## Migration Plan

1. Add coder activity and prompt artifacts behind existing workflow path without changing external API contracts.
2. Wire `runCoderPhase` to call new activity and return either diff manifest or stuck result.
3. Add persistence writes for each attempt and validate schema compatibility with existing `attempts` table usage.
4. Validate end-to-end path in PGLite-backed integration tests with at least: green path, retry path, and each stuck category.
5. Roll out with default attempt budget of 3 from env, monitor attempt outcomes, and tune if retry pressure indicates instability.

Rollback:
- Revert workflow binding to previous no-op implementation and disable coder activity invocation while retaining historical attempt records.

## Open Questions

- What exact diff manifest shape should be standardized for review-agent consumption (minimum required fields)?
- Should flaky-test detection logic be explicit in this phase now, or deferred to a follow-up change?
- Do `dep-missing` and `design-question` require different assignees/routing rules in Linear at launch?
