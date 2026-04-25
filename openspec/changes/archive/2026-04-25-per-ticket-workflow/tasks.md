## 1. Workflow Scaffolding

- [x] 1.1 Add `LinearPollerWorkflow` that polls `listAgentReadyTickets` on a cron interval
- [x] 1.2 Add `PerTicketWorkflow` entrypoint and deterministic workflow ID strategy based on ticket ID
- [x] 1.3 Register the new workflows in Temporal worker/bootstrap wiring

## 2. Phase Activities And Runtime Behavior

- [x] 2.1 Implement no-op `runSpecPhase`, `runCoderPhase`, and `runReviewPhase` activity stubs with logging and success return
- [x] 2.2 Wire per-ticket workflow phase execution order as spec -> coder -> review
- [x] 2.3 Add `cancel` signal handling to stop remaining phase execution and mark cancelled terminal state

## 3. Introspection And Persistence

- [x] 3.1 Add `currentPhase` and `attemptCount` query handlers on `PerTicketWorkflow`
- [x] 3.2 Persist `workflow_runs` row at workflow start
- [x] 3.3 Update `workflow_runs` on each phase transition and terminal completion/cancellation

## 4. Validation

- [x] 4.1 Add or update tests to verify poller idempotent start behavior by ticket ID
- [x] 4.2 Add or update tests for phase ordering, cancel handling, and query responses
- [x] 4.3 Run `npm test` at repository root and ensure all tests pass
