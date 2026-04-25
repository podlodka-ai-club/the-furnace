## 1. Linear Client State Update Capability

- [ ] 1.1 Add typed `updateIssueState(ticketId, stateId)` method in `server/src/linear/client.ts`
- [ ] 1.2 Extend Linear types/contracts for issue state update inputs and responses
- [ ] 1.3 Add integration test coverage for issue-state GraphQL mutation wire shape

## 2. Workflow State Sync Integration

- [ ] 2.1 Add activity boundary for Linear ticket state sync calls
- [ ] 2.2 Update `PerTicketWorkflow` to set Linear state to `In Progress` at workflow start
- [ ] 2.3 Update `PerTicketWorkflow` to set Linear state to `Done` on successful terminal completion
- [ ] 2.4 Update `PerTicketWorkflow` to set Linear state to `Canceled` on cancel terminal completion

## 3. Reliability And Validation

- [ ] 3.1 Configure and document retry/error handling policy for state sync activity failures
- [ ] 3.2 Add/extend Temporal integration tests for lifecycle-driven Linear state transitions
- [ ] 3.3 Run `npm test` from repo root and verify all tests pass
