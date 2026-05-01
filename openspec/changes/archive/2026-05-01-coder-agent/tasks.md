## 1. Coder activity scaffolding

- [x] 1.1 Create `server/src/agents/coder/activity.ts` with typed `runCoderPhase` input/output contract wiring to canonical schemas.
- [x] 1.2 Add `server/src/agents/coder/prompt.md` and load it from coder activity runtime.
- [x] 1.3 Replace ticket-workflow coder phase no-op binding with the real coder activity while preserving phase ordering.

## 2. Iteration loop and environment lifecycle

- [x] 2.1 Implement branch checkout validation for the spec-produced feature branch at the start of each attempt.
- [x] 2.2 Implement the Claude Agent SDK edit/test iteration loop (read failing tests -> edit code -> rerun tests).
- [x] 2.3 Enforce attempt budget from environment (default 3) via Temporal retry-aware attempt handling.
- [x] 2.4 Ensure each retry attempt runs in a fresh pre-warmed ephemeral container and never reuses mutated workspace state.

## 3. Outcome persistence and stuck escalation

- [x] 3.1 Persist one `attempts` row per coder iteration with canonical outcomes: `tests-green`, `retry`, `dep-missing`, `design-question`.
- [x] 3.2 Implement blocker classification rules that distinguish `dep-missing` from `design-question` with evidence capture.
- [x] 3.3 Create typed Linear sub-ticket creation for each stuck class including workflow deep-link context.
- [x] 3.4 Raise non-retryable activity failures for typed stuck outcomes carrying sub-ticket references.

## 4. Success output and downstream contract

- [x] 4.1 Capture committed change metadata from the green commit SHA and build a structured diff manifest.
- [x] 4.2 Return the diff manifest as `CoderPhaseOutput` success shape for review phase consumption.
- [x] 4.3 Update workflow contract parsing/validation so coder output supports both success and stuck variants.

## 5. Verification and integration tests

- [x] 5.1 Add PGLite-backed integration test for green path (failing tests -> green commit -> diff manifest returned).
- [x] 5.2 Add PGLite-backed integration test for retry path with per-attempt rows persisted.
- [x] 5.3 Add PGLite-backed integration tests for `dep-missing` and `design-question` escalation paths with non-retryable failure behavior.
- [x] 5.4 Run `npm test` at repo root and resolve failures before marking the change ready for apply.
