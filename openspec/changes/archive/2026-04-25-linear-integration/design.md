## Context

The orchestrator needs a stable adapter for Linear because ticket intake and human-facing escalations both depend on it. Workflow and activity code should not depend directly on `@linear/sdk` details or GraphQL response shapes. This change introduces a narrow typed client that handles three operations: list `agent-ready` tickets, create typed sub-tickets, and post comments. The adapter must fail fast when credentials are missing and provide deterministic payload shaping so downstream agent phases can call it safely.

## Goals / Non-Goals

**Goals:**
- Provide a single Linear client module with a narrow TypeScript interface for read/write operations used by orchestration activities.
- Enforce environment-based configuration (`LINEAR_API_KEY`, `LINEAR_TEAM_ID`) with startup-time validation.
- Standardize typed sub-ticket creation for `ac-clarification`, `dep-missing`, and `design-question` labels, including workflow deep links.
- Validate integration behavior via HTTP-level stubbing to verify request/response wire shape.

**Non-Goals:**
- Implement ticket polling workflows or Temporal scheduling behavior.
- Add full Linear domain coverage beyond the three required operations.
- Implement retry/backoff policies beyond baseline error propagation from the client layer.

## Decisions

1. **Use a thin wrapper around `@linear/sdk` instead of exposing SDK objects**
   - The client will export project-local types from `server/src/linear/types.ts` and map SDK payloads into those shapes.
   - This keeps SDK-specific fields out of workflow code and reduces blast radius if SDK contracts change.

2. **Validate required env configuration before any network calls**
   - The client constructor/factory will require `LINEAR_API_KEY` and `LINEAR_TEAM_ID` from process environment.
   - Missing values throw an explicit configuration error immediately to avoid partial runtime behavior.

3. **Represent sub-ticket type as a closed union and derive label/body formatting from it**
   - Supported types are `ac-clarification | dep-missing | design-question`.
   - `createSubTicket` will apply a consistent title/body template that includes parent linkage and deep link metadata.
   - A dedicated deep-link helper formats workflow navigation links so all escalation tickets point to a uniform URL shape.

4. **Test at HTTP boundary using SDK transport interception**
   - Integration tests will not mock client methods; instead they will stub outbound HTTP requests and assert GraphQL payload structure and response parsing.
   - This verifies serialization, operation names, variables, and mapping behavior while keeping tests deterministic.

## Risks / Trade-offs

- **[SDK transport behavior may differ between environments]** -> Mitigation: isolate all SDK usage in one module and test outbound request shape in integration tests.
- **[Linear label/team conventions can drift]** -> Mitigation: centralize constants in `types.ts` and fail clearly when required team context is absent.
- **[Sub-ticket text formatting becomes brittle for humans]** -> Mitigation: keep a single formatting helper with explicit tests for generated title/body/deep-link sections.
- **[API errors are noisy for callers]** -> Mitigation: wrap and rethrow with operation-specific context (`listAgentReadyTickets`, `createSubTicket`, `postComment`).

## Migration Plan

1. Add `@linear/sdk` and environment configuration validation support.
2. Implement `server/src/linear/types.ts` and `server/src/linear/client.ts` with the narrow interface and deep-link helper.
3. Add integration tests in `server/tests/integration/linear.test.ts` with HTTP-layer stubs.
4. Wire `.env` docs/defaults for `LINEAR_API_KEY` and `LINEAR_TEAM_ID` in local setup guidance.
5. Run `npm test` to validate integration behavior and existing suite compatibility.

Rollback is straightforward: remove the client module usage and dependency, then revert environment requirement additions.

## Open Questions

- What canonical base URL should deep links use for workflow moments in each environment (local/staging/prod)?
- Should `listAgentReadyTickets` include server-side pagination cursor exposure now, or keep pagination internal and return a full flattened list?
