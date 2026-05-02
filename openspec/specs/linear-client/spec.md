# linear-client Specification

## Purpose

Defines how the Linear client discovers agent-ready tickets, resolves their target repository slug from Linear labels, returns typed ticket data, and covers the Linear-to-workflow dispatch path in integration tests.

## Requirements

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

### Requirement: Linear client resolves the target repo slug from a Linear label

The system SHALL resolve `targetRepoSlug` for each `agent-ready` ticket by inspecting its Linear labels for entries whose name matches the pattern `repo:<slug>`. The candidate slug is the substring after `repo:`. Resolution SHALL succeed only when exactly one such label is present and the candidate slug exists in `build/repos.json` as loaded by the orchestrator process. The resolved slug SHALL be set on the returned `ResolvedTicket.targetRepoSlug` field. The label-name comparison SHALL be exact and case-sensitive — labels like `Repo:Foo` or `repo: foo` SHALL NOT match.

#### Scenario: Single repo label resolves to the matching slug

- **WHEN** an `agent-ready` ticket has exactly one label named `repo:microsoft-vscode-remote-try-node` and that slug is present in `build/repos.json`
- **THEN** the ticket is returned with `targetRepoSlug: "microsoft-vscode-remote-try-node"`

#### Scenario: Non-`repo:` labels are ignored during resolution

- **WHEN** an `agent-ready` ticket carries unrelated labels (e.g., `agent-ready`, `bug`, `priority-high`) alongside a single `repo:<slug>` label
- **THEN** only the `repo:<slug>` label is consulted for resolution and the others are passed through to `labelIds` unchanged

#### Scenario: Label name comparison is exact and case-sensitive

- **WHEN** an `agent-ready` ticket has a label named `Repo:demo` or `repo: demo` (with whitespace)
- **THEN** that label is not treated as a repo signal, and the ticket is handled as if it had no `repo:` label at all

### Requirement: Tickets without a resolvable repo slug are skipped with a logged reason

The system SHALL exclude any `agent-ready` ticket from the `listAgentReadyTickets()` result when its `targetRepoSlug` cannot be resolved. The exclusion conditions are: no `repo:<slug>` label, more than one `repo:<slug>` label, or a `repo:<slug>` label whose candidate slug is not present in `build/repos.json`. For each excluded ticket the client SHALL emit a single structured log entry containing the ticket identifier and a discriminated reason field with one of the values `missing_repo_label`, `ambiguous_repo_label`, or `unknown_repo_slug`. Excluding a ticket SHALL NOT abort the overall poll — other tickets in the same response SHALL still be evaluated and returned if they resolve cleanly.

#### Scenario: Missing repo label causes the ticket to be skipped

- **WHEN** an `agent-ready` ticket carries no label whose name starts with `repo:`
- **THEN** that ticket is excluded from the returned array, a structured log entry naming the ticket identifier and reason `missing_repo_label` is emitted, and other tickets in the same poll continue to be evaluated

#### Scenario: Multiple repo labels are skipped as ambiguous

- **WHEN** an `agent-ready` ticket has two or more labels matching `repo:<slug>` (e.g., `repo:foo` and `repo:bar`)
- **THEN** the ticket is excluded with reason `ambiguous_repo_label` and is not returned

#### Scenario: Unknown slug is skipped, not silently passed through

- **WHEN** an `agent-ready` ticket has a single `repo:<slug>` label but `<slug>` does not appear in `build/repos.json`
- **THEN** the ticket is excluded with reason `unknown_repo_slug` and the log entry includes both the offending slug and a hint pointing at `build/repos.json`

#### Scenario: One bad ticket does not block other tickets

- **WHEN** a single Linear API response contains a mix of resolvable and unresolvable tickets
- **THEN** `listAgentReadyTickets()` returns all resolvable tickets and emits one log entry per unresolvable ticket; the call does not throw

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
- **THEN** it asserts the GraphQL operation and variables include `agent-ready` filtering and team scoping, asserts the selection set includes the `description` field on each issue node, and verifies that a stubbed `description` payload is mapped onto `ResolvedTicket.description`

#### Scenario: createSubTicket validates mutation wire contract

- **WHEN** the integration test intercepts outbound HTTP for `createSubTicket`
- **THEN** it asserts the mutation payload includes parent id, typed label, and deep-link-enriched body, and verifies response mapping succeeds

#### Scenario: updateIssueState validates mutation wire contract

- **WHEN** the integration test intercepts outbound HTTP for `updateIssueState`
- **THEN** it asserts the mutation operation shape includes issue id and state id variables before returning a stubbed success response
