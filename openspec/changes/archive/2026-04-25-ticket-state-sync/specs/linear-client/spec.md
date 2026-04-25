## ADDED Requirements

### Requirement: Linear Client Updates Issue State With Typed Inputs
The system SHALL expose a typed client method to update a Linear issue state by ticket id and target state id.

#### Scenario: Issue state update mutation uses provided ids
- **WHEN** `updateIssueState(ticketId, stateId)` is invoked with valid ids
- **THEN** the client MUST send a Linear issue update mutation referencing exactly the provided `ticketId` and `stateId`

#### Scenario: Mutation acknowledgement resolves call
- **WHEN** Linear acknowledges successful issue state update
- **THEN** `updateIssueState(ticketId, stateId)` MUST resolve without throwing

### Requirement: Integration Tests Validate Issue State Update Wire Contract
The system SHALL include integration test coverage that validates GraphQL payload shape for issue state updates at the HTTP boundary.

#### Scenario: Integration test asserts mutation contract
- **WHEN** the integration test intercepts outbound HTTP for `updateIssueState`
- **THEN** it MUST assert mutation operation shape includes issue id and state id variables before returning a stubbed success response
