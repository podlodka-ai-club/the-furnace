## Why

Concept §2 specifies one Temporal workflow per Linear ticket with phase-level activities for spec, code, and review. This change stands up that skeleton - with activities as no-ops - so MVP agent implementations (including single-review + PR-open completion) plug directly into a durable, signal-driven shell.

## What Changes

- Add a Temporal cron workflow (`LinearPollerWorkflow`) running on a short interval that calls `listAgentReadyTickets` for tickets labeled `agent-ready` in Linear `Todo` state and enqueues a `PerTicketWorkflow` for each new ticket (idempotent via ticket ID).
- Add `PerTicketWorkflow` composed of three phase-level activities invoked in order: `runSpecPhase`, `runCoderPhase`, `runReviewPhase` (each a no-op that logs and returns success).
- Add workflow signals: `cancel`.
- Add workflow queries: `currentPhase`, `attemptCount` for Temporal UI introspection.
- Persist a `workflow_runs` row on start and update on phase transitions.

## Capabilities

### New Capabilities

- `ticket-workflow`: Cron poller + per-ticket workflow skeleton with spec/code/review phase activities, signals, queries, and `workflow_runs` persistence.

### Modified Capabilities

(none)

## Impact

- Depends on: `temporal-setup`, `linear-integration`, `data-model`.
- New files: `server/src/temporal/workflows/linear-poller.ts`, `server/src/temporal/workflows/per-ticket.ts`, `server/src/temporal/activities/phases/*.ts` (no-op stubs).
- The three phase activities are explicit extension points: later changes (`spec-agent`, `coder-agent`, `review-agent`) replace the no-ops with real logic; advanced governance (`persona-reviewers`, `vote-aggregator`) is deferred to Phase 6.
