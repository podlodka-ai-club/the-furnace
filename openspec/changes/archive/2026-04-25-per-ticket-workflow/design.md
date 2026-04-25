## Context

The roadmap schedules `per-ticket-workflow` as the last Phase 2 change after `temporal-setup`, `linear-integration`, and `agent-io-contracts`. The proposal calls for a durable orchestration shell that polls Linear for `agent-ready` tickets, starts one workflow per ticket, and runs three phase-level activities (spec, coder, review) as no-ops for now.

The current repository already has foundational Temporal, Linear client, and persistence capabilities. This change must connect them without introducing real agent logic yet, while preserving extension points for later changes (`spec-agent`, `coder-agent`, `review-agent`).

## Goals / Non-Goals

**Goals:**
- Implement a cron-based poller workflow that discovers agent-ready Linear tickets and starts per-ticket workflows idempotently by ticket ID.
- Implement a per-ticket workflow with ordered no-op phases: spec -> coder -> review.
- Expose workflow control and introspection via `cancel` signal and `currentPhase` / `attemptCount` queries.
- Persist `workflow_runs` lifecycle state at workflow start and on each phase transition.

**Non-Goals:**
- Implementing real spec/coder/review agent behavior or tool execution.
- Adding advanced governance features (persona reviews, vote aggregation, Slack notifications).
- Adding new ticket types beyond polling existing `agent-ready` tickets.

## Decisions

### Decision: Split orchestration into two workflows

Use `LinearPollerWorkflow` for periodic ticket discovery and `PerTicketWorkflow` for ticket execution.

- **Why:** Separates queue-discovery cadence from per-ticket execution state, keeping retries and observability focused per responsibility.
- **Alternative considered:** A single workflow doing both polling and phase execution. Rejected because long-lived mixed concerns increase complexity and make idempotency harder to reason about.

### Decision: Enforce ticket-level idempotency with deterministic workflow IDs

Start each per-ticket workflow with a stable Temporal workflow ID derived from the Linear ticket ID.

- **Why:** Prevents duplicate runs across repeated poll cycles without external locking.
- **Alternative considered:** Database-only deduplication before start. Rejected because it introduces additional race windows and duplicates Temporal-native guarantees.

### Decision: Keep phase activities as explicit no-op activity functions

Implement `runSpecPhase`, `runCoderPhase`, and `runReviewPhase` as separate no-op activities returning success.

- **Why:** Preserves stable extension points for later agent implementation changes while already exercising activity orchestration and retries.
- **Alternative considered:** Inline phase logic in workflow code. Rejected because it removes activity boundaries that later agent integrations rely on.

### Decision: Track phase progression in both workflow memory and `workflow_runs`

Maintain in-workflow phase state for queries and update `workflow_runs` at start + phase transitions.

- **Why:** Temporal queries provide live introspection, while database rows provide durable auditability outside Temporal UI.
- **Alternative considered:** Query-only state with no DB updates. Rejected because downstream reporting and traceability require persisted status.

## Risks / Trade-offs

- **[Duplicate starts under polling races]** -> Mitigate with deterministic workflow IDs and "already started" handling as a non-fatal outcome.
- **[Visibility mismatch between Temporal and DB states]** -> Mitigate by centralizing transition writes immediately before each phase activity call.
- **[No-op behavior masks future integration issues]** -> Mitigate by keeping explicit typed activity boundaries and adding follow-up changes to replace stubs incrementally.

## Migration Plan

1. Add new workflow and activity modules for poller, per-ticket orchestration, and phase stubs.
2. Register workflows/activities with existing Temporal worker bootstrap.
3. Wire poller to Linear ticket listing and per-ticket workflow start behavior.
4. Add `workflow_runs` writes on workflow start and each phase transition.
5. Validate end-to-end by running a local worker and confirming one `agent-ready` ticket flows through all three no-op phases.

Rollback strategy: disable or undeploy the poller workflow registration while preserving schema and existing capabilities; remove new workflow registration in a revert if needed.

## Open Questions

- Should poller cadence be fixed in code for this phase, or configurable via environment variable immediately?
- What exact terminal status values in `workflow_runs` should represent cancellation and successful completion to align with later PR-opening flow?
