## 1. Dependency and configuration setup

- [x] 1.1 Add `@linear/sdk` to server dependencies and ensure lockfile updates are committed.
- [x] 1.2 Add environment parsing/validation for `LINEAR_API_KEY` and `LINEAR_TEAM_ID` with fail-fast errors.

## 2. Linear client implementation

- [x] 2.1 Define Linear domain types and supported sub-ticket type union in `server/src/linear/types.ts`.
- [x] 2.2 Implement `server/src/linear/client.ts` with `listAgentReadyTickets`, `createSubTicket`, and `postComment` using a narrow typed interface.
- [x] 2.3 Add deep-link formatting helper used by sub-ticket creation and cover its output shape with unit-level assertions if needed.

## 3. Integration verification

- [x] 3.1 Add `server/tests/integration/linear.test.ts` that stubs Linear at HTTP level and verifies request/response wire shape for list/create/comment paths.
- [x] 3.2 Run `npm test` from repo root and fix any regressions introduced by the Linear integration.

## 4. Documentation and readiness

- [x] 4.1 Update local environment documentation/examples to include `LINEAR_API_KEY` and `LINEAR_TEAM_ID`.
- [x] 4.2 Verify exported client API is importable by activities without Temporal coupling.
