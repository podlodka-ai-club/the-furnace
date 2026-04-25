## Why

Linear is the external queue from which tickets enter the pipeline and the surface on which agent escalations (clarification, stuck) become visible to humans. A thin, well-typed client insulates workflow code from Linear SDK specifics and keeps sub-ticket shape consistent.

## What Changes

- Add `@linear/sdk` dependency.
- Add `server/src/linear/client.ts` exposing a narrow interface:
  - `listAgentReadyTickets(): Promise<Ticket[]>` — paginated query for the `agent-ready` label.
  - `createSubTicket(parentId, type, body, workflowDeepLink)` — writes a typed sub-ticket with a machine-readable label matching `type` (`ac-clarification`, `dep-missing`, `design-question`).
  - `postComment(ticketId, body)` — used later for human-tiebreaker posts by `vote-aggregator`.
- Add environment configuration (`LINEAR_API_KEY`) loaded from `.env`; fail fast on missing keys.
- Add a deep-link helper that formats a link back to the stuck workflow moment (used by spec/coder agents).
- Integration tests stub the Linear API at the HTTP layer (not at the SDK layer) so wire shape is verified.

## Capabilities

### New Capabilities

- `linear-client`: Typed read/write client for `agent-ready` tickets, typed clarification/stuck sub-tickets, and workflow-moment deep links.

### Modified Capabilities

(none)

## Impact

- New dep: `@linear/sdk`.
- New files: `server/src/linear/client.ts`, `server/src/linear/types.ts`, `server/tests/integration/linear.test.ts`.
- New env vars: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`.
- Independent of Temporal — importable from activities, tests, and scripts.
