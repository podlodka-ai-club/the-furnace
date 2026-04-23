## Why

The coder agent turns the spec agent's failing tests into green tests — the implementation counterpart to the spec / code split from concept §3.4. Stuck states (missing dependency, design-level ambiguity) escalate via typed Linear sub-tickets rather than burning attempts.

## What Changes

- Replace the `runCoderPhase` no-op with a Claude Agent SDK loop that:
  1. Checks out the spec agent's feature branch inside the ephemeral container.
  2. Iterates: read failing tests → edit code → run tests → commit on green.
  3. Enforces an attempt budget via Temporal retry policy; each retry starts from a fresh pre-warmed container per §3.6.
  4. On persistent failure of a specific class, opens a `dep-missing` or `design-question` sub-ticket with workflow deep-link and fails the activity with a non-retryable error.
- Writes an `attempts` row per iteration (outcome: `tests-green` | `retry` | `dep-missing` | `design-question`).
- Captures the final diff as output for the review phase.

## Capabilities

### New Capabilities

- `code-generation`: Failing-tests → green-tests iteration loop with typed stuck escalation paths and per-attempt ephemerality.

### Modified Capabilities

- `ticket-workflow`: `runCoderPhase` now returns a diff manifest consumed by the review phase, or signals stuck-with-sub-ticket.

## Impact

- Depends on: `spec-agent` (feature branch convention, SDK setup), `container-as-worker`, `linear-integration`.
- New files: `server/src/agents/coder/activity.ts`, `server/src/agents/coder/prompt.md`.
- Reuses the Claude Agent SDK dependency added by `spec-agent`.
- Attempt budget default: 3 (tunable via env).
