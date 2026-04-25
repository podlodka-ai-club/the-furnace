## Context

Per-ticket workflows now execute durably in Temporal and persist internal run state to `workflow_runs`, but Linear issue state remains unchanged unless manually updated by humans. This creates drift between orchestration truth and ticket-board truth, especially when workflows succeed, fail, or are cancelled outside the Linear UI.

The change needs to synchronize Linear issue state at key workflow lifecycle points without weakening workflow reliability. Linear mutations are external side effects and can fail transiently, so synchronization must be retry-safe and idempotent.

## Goals / Non-Goals

**Goals:**
- Update Linear issue state when per-ticket workflows enter key lifecycle transitions.
- Keep transition semantics explicit and deterministic across success/cancel/failure paths.
- Preserve workflow durability if Linear update attempts fail transiently.
- Provide test coverage for GraphQL wire shape and workflow-driven state transitions.

**Non-Goals:**
- Reworking existing phase logic beyond adding state-sync hooks.
- Implementing complex policy routing per ticket type or team.
- Introducing multi-system transactional guarantees across Temporal and Linear.

## Decisions

### Decision: Use explicit lifecycle-to-state mapping in workflow layer

Map workflow events directly in `PerTicketWorkflow`:
- start -> Linear `In Progress`
- successful completion -> Linear `Done`
- cancelled completion -> Linear `Canceled`

**Why:** Mapping in workflow code keeps state transitions auditable and colocated with lifecycle control flow.

**Alternative considered:** Derive Linear state from persisted DB status asynchronously. Rejected because it adds eventual-consistency delay and a second synchronization subsystem.

### Decision: Add typed Linear client mutation for issue state update

Extend `linear-client` with a dedicated method for state transition, accepting ticket id and target state id.

**Why:** Keeps GraphQL details encapsulated in one client and preserves typed boundary contracts for workflows and activities.

**Alternative considered:** Inline GraphQL mutation directly in activity code. Rejected because it duplicates transport/config logic and weakens testability.

### Decision: Treat state sync as retryable activity side effect

State updates run through activities with standard Temporal retry behavior. Terminal workflow completion is blocked only by durable activity outcome according to configured retries.

**Why:** This keeps failure handling explicit and consistent with other external calls.

**Alternative considered:** Fire-and-forget updates after workflow completion. Rejected because failures become invisible and produce silent drift.

## Risks / Trade-offs

- **[State-name mismatch across Linear teams]** -> Mitigate with explicit configuration/mapping validation and startup-time checks.
- **[External API transient failures delay terminal completion]** -> Mitigate with bounded retries and observability around repeated failures.
- **[Partial drift if manual user changes happen concurrently]** -> Mitigate by defining lifecycle updates as authoritative only at workflow transition points.

## Migration Plan

1. Extend Linear client with typed issue-state update method and integration tests.
2. Add workflow activity wrapper for state updates.
3. Wire lifecycle transition hooks into per-ticket workflow start/success/cancel paths.
4. Run full test suite and an end-to-end milestone check with a fresh `agent-ready` ticket.

Rollback: remove workflow hooks to state updates while retaining read-only polling behavior; keep client additions unused if needed.

## Open Questions

- Should failure terminal state map to `Canceled` or a dedicated `Failed` state if available in team workflow?
- Should target state IDs come from explicit env vars or dynamic lookup by canonical state names at runtime?
