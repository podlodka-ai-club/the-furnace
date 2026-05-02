## Context

The Linear poller (`server/src/linear/client.ts`) issues a hand-written GraphQL query named `ListAgentReadyTickets` that selects only `id`, `identifier`, `title`, `priority`, `labelIds`, and `labels { nodes { id, name } }`. The result is mapped into a `ResolvedTicket` and forwarded by `linear-poller.ts` into the per-ticket workflow as `{ id, identifier, title }`. Inside the per-ticket workflow, `persistWorkflowRunStart` writes a row into the `tickets` table — but the `ac_text` column is hard-coded to the literal string `"pending acceptance criteria"` (`server/src/temporal/activities/workflow-runs.ts:27`). The spec-agent activity then reads this row back via `fetchTicketFromDb` and uses `ac_text` as the description it shows the agent.

The result is that even though the Linear ticket has a real description authored by a human, the agent never sees it. Adding `description` to the Linear poll, propagating it through the workflow, and persisting it correctly closes that gap. Because the `tickets.ac_text` column already exists and is already wired into the read path, this is an end-to-end plumbing change rather than a schema change.

## Goals / Non-Goals

**Goals:**
- Read `description` from Linear at the polling boundary so that downstream code (per-ticket workflow, DB, spec agent) operates on the real ticket body.
- Keep `ResolvedTicket` and `ReviewerTicket` typed as non-nullable — descriptions absent on Linear become an empty string, not `undefined`, so consumers do not need null-checks.
- Update the existing wire-shape and end-to-end integration tests so their stubs and assertions cover the new field, preventing the change from silently regressing.
- Persist the latest description into `tickets.ac_text` on every poll (via `ON CONFLICT ... DO UPDATE`), so an edited Linear ticket eventually overwrites stale rows when re-polled.

**Non-Goals:**
- Renaming `tickets.ac_text` to `tickets.description` — out of scope; the column name is already a known wart, but a rename ripples through migrations, the spec activity, and other readers and is best done as its own change.
- Parsing or templating description content (e.g., extracting an "Acceptance Criteria" subsection). This change moves the raw description through; structure-aware parsing is left to a future spec-agent change.
- Streaming description updates from Linear webhooks. Description refresh continues to happen only when the next poll picks the ticket up.
- Adding `description` to sub-tickets created via `createSubTicket`. That path already supplies its own body and is unaffected.

## Decisions

### Decision: Extend the existing GraphQL query rather than introducing a new one
We add a single `description` field to the existing `ListAgentReadyTickets` query. Linear's `Issue.description` field is a nullable Markdown string and is part of the standard issue surface, so no extra permissions or query split is required. Splitting into a separate "fetch full body" query was considered but rejected — it would double the request count per poll and add a partial-failure mode (title fetched, description not), which is worse than just selecting one extra field.

### Decision: Treat missing/empty Linear descriptions as empty string, not optional
`ResolvedTicket.description` is typed as `string` (required). When Linear returns `null` or an empty string for `description`, the client coerces to `""`. This keeps the type contract simple at every downstream boundary (workflow input, DB column, agent prompt). The alternative — `description?: string` — would force every consumer (Zod schema, DB write, agent prompt template) to either branch on undefined or coerce, multiplying the surface area for the same end behaviour.

### Decision: Persist description into the existing `tickets.ac_text` column
The `tickets` table already has an `ac_text` column that the spec activity reads as `description` (`server/src/db/tickets.ts:30`). Routing the new value into this same column means the existing read path "just works" and no migration is needed. Renaming the column would be cleaner but bigger; it is called out as a non-goal so this change can land independently. We also flip the `ON CONFLICT` clause to update both `title` and `ac_text` so a re-polled ticket reflects edits made in Linear.

### Decision: Carry `description` through `PerTicketWorkflowInput.ticket`, not as a side payload
We extend `ReviewerTicket` (the canonical typed ticket projection) with a required `description` string. `PerTicketWorkflowInput.ticket` is already typed as `ReviewerTicket`, so no new field on the workflow input itself is needed. This keeps the description colocated with the rest of the ticket identity and avoids fanning out a parallel path. Reviewer prompts that don't currently use the description will keep ignoring it; nothing forces them to consume it.

### Decision: GraphQL field selection lives in the spec, not just the implementation
The `linear-client` spec already has a requirement that pins the GraphQL selection set ("the query SHALL request label `name` alongside `id`"). We add a parallel requirement pinning the inclusion of `description` so the wire-shape integration test has spec-level cover and a future refactor can't quietly drop the field.

## Risks / Trade-offs

- [Risk] Existing `tickets` rows in dev/test PGLite databases still contain the literal `"pending acceptance criteria"` string. → Mitigation: the `ON CONFLICT ... DO UPDATE` change rewrites `ac_text` on the next poll, so stale rows self-heal once the workflow runs again. No backfill is needed for production because production hasn't shipped yet (orchestrator is still in development per the roadmap).
- [Risk] Linear descriptions can be very large (tens of KB, occasionally with embedded images as Markdown links). → Mitigation: `tickets.ac_text` is a text column with no length cap; large bodies are persisted as-is. Spec-agent prompt-length concerns belong to a future spec-agent change, not here.
- [Risk] Adding a required field to `ReviewerTicket` is a breaking type change for any in-flight code constructing the type. → Mitigation: only the orchestrator constructs `ReviewerTicket`/`ResolvedTicket` today, and all construction sites are updated in the same change. The Zod schema in `reviewer-io.ts` is the single source of truth and updating it surfaces every miss at typecheck time.
- [Risk] If Linear ever renames or removes `Issue.description`, the GraphQL query starts failing for every poll. → Mitigation: the wire-shape integration test asserts the query body and a stubbed response with `description`, so a contract drift surfaces in CI rather than only at runtime. We accept the risk that Linear could change the API; it has not changed historically.
- [Trade-off] Persisting into `tickets.ac_text` keeps the migration-free path but bakes in the column-name mismatch a little deeper. → Acceptable given the "clean rename" non-goal; a dedicated rename change can address it later without re-doing this plumbing.
