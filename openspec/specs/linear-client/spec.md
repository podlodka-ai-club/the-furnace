# linear-client Specification

## Requirements

### Requirement: Linear client lists agent-ready tickets using typed results

The system SHALL expose `listAgentReadyTickets(): Promise<Ticket[]>` from `server/src/linear/client.ts` and query Linear for tickets tagged `agent-ready` within the configured team context. The returned value SHALL use project-local `Ticket` types from `server/src/linear/types.ts` rather than raw SDK types.

#### Scenario: Agent-ready tickets are returned as local typed objects

- **WHEN** Linear returns one or more tickets with the `agent-ready` label for the configured team
- **THEN** `listAgentReadyTickets()` resolves with an array of `Ticket` objects containing the mapped id, identifier, title, and workflow-relevant metadata

#### Scenario: Pagination is handled transparently

- **WHEN** the Linear API response indicates additional pages of `agent-ready` tickets
- **THEN** `listAgentReadyTickets()` continues fetching until exhaustion and returns a single flattened array

### Requirement: Linear client creates typed escalation sub-tickets

The system SHALL expose `createSubTicket(parentId, type, body, workflowDeepLink)` where `type` MUST be one of `ac-clarification`, `dep-missing`, or `design-question`. The created sub-ticket SHALL include machine-readable type labeling and a body section containing the provided workflow deep link.

#### Scenario: Clarification sub-ticket is created with required type label

- **WHEN** `createSubTicket` is called with `type = "ac-clarification"`
- **THEN** the Linear create-issue mutation includes the parent link, the `ac-clarification` label, and the caller-provided description content

#### Scenario: Stuck sub-ticket includes workflow deep link

- **WHEN** `createSubTicket` is called with `type = "dep-missing"` or `type = "design-question"`
- **THEN** the created issue body includes a dedicated workflow link section containing `workflowDeepLink` so humans can jump to the stuck run context

### Requirement: Linear client posts comments on existing tickets

The system SHALL expose `postComment(ticketId, body)` and submit a Linear comment mutation that attaches `body` to the target ticket.

#### Scenario: Comment mutation targets the requested ticket

- **WHEN** `postComment(ticketId, body)` is invoked with a valid ticket id
- **THEN** the client sends a comment create mutation referencing that ticket id and resolves after Linear acknowledges creation

### Requirement: Linear client updates issue state with typed inputs

The system SHALL expose `updateIssueState(ticketId, stateId): Promise<void>` and submit a Linear issue update mutation that sets `stateId` for the target `ticketId`.

#### Scenario: Issue state update mutation uses provided ids

- **WHEN** `updateIssueState(ticketId, stateId)` is invoked with valid ids
- **THEN** the client MUST send a Linear issue update mutation referencing exactly the provided `ticketId` and `stateId`

#### Scenario: Mutation acknowledgement resolves call

- **WHEN** Linear acknowledges successful issue state update
- **THEN** `updateIssueState(ticketId, stateId)` MUST resolve without throwing

### Requirement: Linear configuration is validated at initialization

The system SHALL require `LINEAR_API_KEY` and `LINEAR_TEAM_ID` from environment configuration before client operations execute, and SHALL fail fast with a descriptive error when either value is missing.

#### Scenario: Missing API key fails fast

- **WHEN** the client is initialized without `LINEAR_API_KEY`
- **THEN** initialization throws an error that names `LINEAR_API_KEY` as required and no Linear request is attempted

#### Scenario: Missing team id fails fast

- **WHEN** the client is initialized without `LINEAR_TEAM_ID`
- **THEN** initialization throws an error that names `LINEAR_TEAM_ID` as required and no Linear request is attempted

### Requirement: Integration tests verify wire shape at HTTP boundary

The system SHALL include integration tests in `server/tests/integration/linear.test.ts` that stub Linear at the HTTP layer and assert GraphQL operation payload and response mapping for each client method.

#### Scenario: listAgentReadyTickets validates query wire contract

- **WHEN** the integration test intercepts outbound HTTP for `listAgentReadyTickets`
- **THEN** it asserts the GraphQL operation and variables include `agent-ready` filtering and team scoping before returning a stubbed response

#### Scenario: createSubTicket validates mutation wire contract

- **WHEN** the integration test intercepts outbound HTTP for `createSubTicket`
- **THEN** it asserts the mutation payload includes parent id, typed label, and deep-link-enriched body, and verifies response mapping succeeds

#### Scenario: updateIssueState validates mutation wire contract

- **WHEN** the integration test intercepts outbound HTTP for `updateIssueState`
- **THEN** it asserts the mutation operation shape includes issue id and state id variables before returning a stubbed success response
