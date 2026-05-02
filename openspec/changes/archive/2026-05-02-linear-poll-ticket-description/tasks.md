## 1. Linear client wire-shape changes

- [x] 1.1 Add `description: string` to `Ticket` (and therefore `ResolvedTicket`) in `server/src/linear/types.ts`
- [x] 1.2 Extend the `LIST_AGENT_READY_TICKETS_QUERY` GraphQL operation in `server/src/linear/client.ts` to select the `description` field on each issue node
- [x] 1.3 Update `ListAgentReadyTicketsResponse` to declare `description?: string | null` on each node and map it onto `ResolvedTicket.description`, coercing `null`/missing/empty values to `""`

## 2. Workflow input propagation

- [x] 2.1 Add `description: z.string()` to `reviewerTicketSchema` in `server/src/agents/contracts/reviewer-io.ts` so the type flows through `ReviewerTicket`
- [x] 2.2 Update `linear-poller.ts` to forward `description: ticket.description` into the `PerTicketWorkflowInput.ticket` payload alongside id/identifier/title
- [x] 2.3 Update `PersistWorkflowRunStartInput.ticket` in `server/src/temporal/activities/workflow-runs.ts` to require `description: string`

## 3. Persistence

- [x] 3.1 Change the `persistWorkflowRunStart` SQL to insert `input.ticket.description` into the `ac_text` column instead of the `"pending acceptance criteria"` literal
- [x] 3.2 Update the `ON CONFLICT (external_id) DO UPDATE` clause to also overwrite `ac_text` from `EXCLUDED.ac_text` so re-polled tickets pick up edited descriptions
- [x] 3.3 Confirm `fetchTicketFromDb` still returns `ac_text` as `description` and no other readers depend on the old placeholder string

## 4. Tests

- [x] 4.1 In `server/tests/integration/linear.test.ts`, extend the stubbed Linear payload for `listAgentReadyTickets` to include `description` values (one non-empty, one `null`) and assert the `description` field on the resulting `ResolvedTicket`s, including the empty-string coercion path
- [x] 4.2 In the same test, assert that the GraphQL query body sent on the wire includes the `description` selection
- [x] 4.3 In the linear → workflow → container integration test, stub a non-empty Linear description and assert the per-ticket workflow received a `ticket.description` matching the stub, and that the row written to `tickets.ac_text` contains the same value
- [x] 4.4 Add or extend a unit test (or reuse an existing one) covering `persistWorkflowRunStart` to verify the description is written and that re-running with an edited description updates `ac_text`

## 5. Verification

- [x] 5.1 Run `pnpm -C server typecheck` and resolve any type errors introduced by the new required field
- [x] 5.2 Run the full Vitest suite (`pnpm -C server test`) and ensure existing tests either pass unchanged or are updated to supply `description` on test-built ticket fixtures
- [x] 5.3 Run `openspec verify --change linear-poll-ticket-description` (or the equivalent `/opsx:verify`) before archival
