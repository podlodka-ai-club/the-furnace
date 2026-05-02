## MODIFIED Requirements

### Requirement: Linear client lists agent-ready tickets using typed results

The system SHALL expose `listAgentReadyTickets(): Promise<ResolvedTicket[]>` from `server/src/linear/client.ts` and query Linear for tickets tagged `agent-ready` within the configured team context. The returned value SHALL use a `ResolvedTicket` type from `server/src/linear/types.ts` whose `targetRepoSlug: string` field is required and known to be a registered slug. Tickets SHALL NOT appear in the result unless their `targetRepoSlug` has been resolved from a Linear label of the form `repo:<slug>` whose `<slug>` matches an entry in `build/repos.json`. The Linear GraphQL query SHALL request label `name` alongside `id` so resolution can read label strings directly from the response. The Linear GraphQL query SHALL also request the issue `description` field, and each `ResolvedTicket` SHALL include a `description: string` populated from that field; when Linear returns `null` or an empty value for `description`, the client SHALL coerce it to the empty string so the contract is non-nullable.

#### Scenario: Agent-ready tickets are returned as resolved typed objects

- **WHEN** Linear returns one or more tickets carrying both the `agent-ready` label and exactly one `repo:<slug>` label whose slug matches `build/repos.json`
- **THEN** `listAgentReadyTickets()` resolves with an array of `ResolvedTicket` objects containing the mapped id, identifier, title, description, workflow-relevant metadata, and the resolved `targetRepoSlug`

#### Scenario: Pagination is handled transparently

- **WHEN** the Linear API response indicates additional pages of `agent-ready` tickets
- **THEN** `listAgentReadyTickets()` continues fetching until exhaustion, applies repo-slug resolution per ticket, and returns a single flattened array of resolved tickets only

#### Scenario: Description is sourced from the Linear issue body

- **WHEN** Linear returns an `agent-ready` ticket whose `description` field is a non-empty Markdown string
- **THEN** the corresponding `ResolvedTicket.description` SHALL equal that string verbatim, with no truncation, trimming, or transformation

#### Scenario: Missing description is coerced to empty string

- **WHEN** Linear returns an `agent-ready` ticket whose `description` field is `null`, missing, or an empty string
- **THEN** the corresponding `ResolvedTicket.description` SHALL equal `""` and the ticket SHALL still be returned (the missing description does not cause exclusion)

### Requirement: Integration tests cover Linear → workflow → container launch end-to-end

The system SHALL include an integration test in `server/tests/integration/` that exercises the full path from a stubbed Linear HTTP response through `listAgentReadyTickets`, the linear-poller workflow, the per-ticket workflow, and the `launchWorkerContainer` activity invocation, without injecting `targetRepoSlug` directly into any workflow input. The test SHALL stub Linear at the HTTP layer with a payload that includes label `name` data and a non-empty `description` string and SHALL assert the resulting workflow input received by the per-ticket workflow carries both the resolved slug and the same `description` value. The test SHALL also cover the `missing_repo_label`, `ambiguous_repo_label`, and `unknown_repo_slug` skip paths and assert that no workflow is started for skipped tickets.

#### Scenario: Happy path resolves slug and launches containers

- **WHEN** the integration test stubs Linear with one ticket carrying `agent-ready`, a single matching `repo:<slug>` label, and a non-empty `description`, and runs the linear-poller workflow against an in-process Temporal test environment
- **THEN** the per-ticket workflow runs to completion, its `ticket.description` input equals the stubbed Linear description, and `launchWorkerContainer` is invoked once per phase (spec, coder, review) with `repoSlug` equal to the slug encoded in the label

#### Scenario: Skipped ticket starts no workflow

- **WHEN** the integration test stubs Linear with one ticket that has no `repo:<slug>` label
- **THEN** the linear-poller workflow returns `started: 0` for that ticket, no per-ticket workflow is started, and a structured log entry with reason `missing_repo_label` is emitted

#### Scenario: Mixed batch resolves valid tickets and skips invalid ones

- **WHEN** the integration test stubs Linear with one resolvable ticket and one ticket carrying two `repo:<slug>` labels
- **THEN** exactly one per-ticket workflow is started for the resolvable ticket, the ambiguous ticket is skipped with reason `ambiguous_repo_label`, and `launchWorkerContainer` is invoked only for the resolvable ticket

### Requirement: Integration tests verify wire shape at HTTP boundary

The system SHALL include integration tests in `server/tests/integration/linear.test.ts` that stub Linear at the HTTP layer and assert GraphQL operation payload and response mapping for each client method.

#### Scenario: listAgentReadyTickets validates query wire contract

- **WHEN** the integration test intercepts outbound HTTP for `listAgentReadyTickets`
- **THEN** it asserts the GraphQL operation and variables include `agent-ready` filtering and team scoping, asserts the selection set includes the `description` field on each issue node, and verifies that a stubbed `description` payload is mapped onto `ResolvedTicket.description`

#### Scenario: createSubTicket validates mutation wire contract

- **WHEN** the integration test intercepts outbound HTTP for `createSubTicket`
- **THEN** it asserts the mutation payload includes parent id, typed label, and deep-link-enriched body, and verifies response mapping succeeds

#### Scenario: updateIssueState validates mutation wire contract

- **WHEN** the integration test intercepts outbound HTTP for `updateIssueState`
- **THEN** it asserts the mutation operation shape includes issue id and state id variables before returning a stubbed success response
