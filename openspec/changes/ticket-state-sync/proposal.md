## Why

Phase 2 currently completes the per-ticket workflow without reflecting terminal state back to Linear, which leaves human ticket status out of sync with orchestration state. We need explicit, durable ticket state synchronization so Linear remains the reliable source of truth for humans.

## What Changes

- Add workflow-driven Linear status synchronization for per-ticket lifecycle transitions.
- Set ticket state to "In Progress" when a per-ticket workflow begins execution.
- Set ticket state to "Done" when review phase completes successfully.
- Set ticket state to "Canceled" when workflow is cancelled.
- Define failure behavior for state updates (retry + non-fatal handling policy) so workflow durability is preserved.
- Add integration tests covering Linear mutation wire shape and end-to-end state transition behavior.

## Capabilities

### New Capabilities
- `ticket-state-sync`: Map per-ticket workflow lifecycle events to Linear issue state transitions with deterministic rules and retry-safe behavior.

### Modified Capabilities
- `linear-client`: Add typed client support for updating issue state by ticket id and target state id.

## Impact

- Affects `server/src/temporal/workflows/per-ticket.ts` and related transition logic.
- Affects `server/src/linear/client.ts` and `server/src/linear/types.ts` for state update methods.
- Adds/updates integration tests in `server/tests/integration/linear.test.ts` and Temporal orchestration tests.
- Introduces dependency on configured Linear team state IDs (or a discoverable mapping strategy) for `In Progress`, `Done`, and `Canceled`.
