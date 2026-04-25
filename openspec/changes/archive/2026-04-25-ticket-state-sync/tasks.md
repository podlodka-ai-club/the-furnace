## 1. Linear Client State Update Capability

- [x] 1.1 Add typed `updateIssueState(ticketId, stateId)` method in `server/src/linear/client.ts`
- [x] 1.2 Extend Linear types/contracts for issue state update inputs and responses
- [x] 1.3 Add integration test coverage for issue-state GraphQL mutation wire shape

## 2. Workflow State Sync Integration

- [x] 2.1 Add activity boundary for Linear ticket state sync calls
- [x] 2.2 Update `PerTicketWorkflow` to set Linear state to `In Progress` at workflow start
- [x] 2.3 Update `PerTicketWorkflow` to set Linear state to `Done` on successful terminal completion
- [x] 2.4 Update `PerTicketWorkflow` to set Linear state to `Canceled` on cancel terminal completion

## 3. Reliability And Validation

- [x] 3.1 Configure and document retry/error handling policy for state sync activity failures
- [x] 3.2 Add/extend Temporal integration tests for lifecycle-driven Linear state transitions
- [x] 3.3 Run `npm test` from repo root and verify all tests pass
