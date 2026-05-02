## Why

The Linear poller currently fetches only ticket title; the description is never read from Linear. Downstream code papers over this by writing the literal placeholder `"pending acceptance criteria"` into `tickets.ac_text`, which then becomes the description handed to the spec agent. The agent therefore has no view of what the human ticket author actually wrote, defeating the point of the Linear → spec handoff.

## What Changes

- Extend the `agent-ready` Linear GraphQL query to request `description` alongside `title`.
- Add a `description: string` field to `ResolvedTicket` (and the underlying `Ticket`) in `server/src/linear/types.ts`. Treat absent descriptions as empty string so the contract stays non-nullable.
- Propagate the description through `PerTicketWorkflowInput.ticket` (and the linear-poller workflow that builds it) so it reaches the per-ticket workflow alongside id/identifier/title.
- Persist the real description into `tickets.ac_text` via `persistWorkflowRunStart`, replacing the `"pending acceptance criteria"` placeholder. On conflict, update `ac_text` so re-polled tickets pick up edited descriptions.
- Update the wire-shape and end-to-end integration tests to stub Linear with a `description` field and assert it survives the round-trip into per-ticket workflow input and the database.

## Capabilities

### New Capabilities
<!-- None — this change extends an existing capability rather than introducing a new one. -->

### Modified Capabilities
- `linear-client`: `listAgentReadyTickets` returns `ResolvedTicket` objects that include a `description` string sourced from the Linear `description` field; the GraphQL query and integration tests are extended accordingly.

## Impact

- Code:
  - `server/src/linear/client.ts` (GraphQL query + response mapping)
  - `server/src/linear/types.ts` (`Ticket` / `ResolvedTicket` shape)
  - `server/src/temporal/workflows/linear-poller.ts` (forwarding to child workflow input)
  - `server/src/temporal/workflows/per-ticket.ts` and `server/src/agents/contracts/reviewer-io.ts` (`ReviewerTicket` / `PerTicketWorkflowInput.ticket` shape)
  - `server/src/temporal/activities/workflow-runs.ts` (persist real description into `tickets.ac_text`)
  - `server/tests/integration/linear.test.ts` and the linear → workflow → container integration test (stub payloads + assertions)
- APIs: `Ticket`, `ResolvedTicket`, `ReviewerTicket`, and `PerTicketWorkflowInput` all gain a required `description` field. This is a non-breaking enrichment for the orchestrator process, but any other consumer constructing these types will need to supply the field.
- Dependencies: none — uses existing Linear SDK and GraphQL surface.
- Data: `tickets.ac_text` will be populated with the actual Linear description instead of a placeholder string. No schema migration is required; only the value written changes.
