## Why

Four persona votes mean nothing without an aggregation rule that turns them into action. Concept §2: unanimous pass → auto-merge with veto window (cheap); split vote → human tiebreaker in Linear (expensive but rare). The aggregator is where this allocation decision lives.

## What Changes

- Add an aggregator activity invoked after the four reviewer activities return.
- Decision logic:
  - Unanimous `approve` → enqueue the PR for auto-merge and start a Temporal `sleep(vetoWindow)`. A `vetoOverride` signal during the sleep cancels the merge. Notify Slack at sleep start (per `slack-notifications`).
  - Any `reject` → post a Linear comment on the ticket summarizing each persona's reasoning (via `linear-integration`) and transition the workflow into a `pending-human-tiebreak` state awaiting an `approveMergeVeto` signal.
- Default veto window: 15 minutes (configurable via env).
- Aggregation result is persisted to `workflow_runs` (`outcome: auto-merge | human-tiebreak`).

## Capabilities

### New Capabilities

- `vote-aggregation`: Unanimous-vs-split decision rule, veto window with signal-cancellable auto-merge, and human-tiebreak escalation via Linear comments.

### Modified Capabilities

- `ticket-workflow`: Completes with either auto-merge-after-window or pauses awaiting human signal.

## Impact

- Depends on: `persona-reviewers`, `linear-integration`, `slack-notifications` (for the alert), `data-model`.
- New files: `server/src/temporal/activities/vote-aggregator.ts`, `server/src/temporal/signals.ts` (adds `vetoOverride` and `approveMergeVeto` signal definitions).
- The actual merge action lives in `github-adapter`; this change only decides whether to enqueue it.
