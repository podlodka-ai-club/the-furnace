## ADDED Requirements

### Requirement: Express Serves Ticket Activity UI

The system SHALL serve a React-based ticket activity interface from the existing Express application used by `npm run dev`. The Express application SHALL continue to expose `/health` and existing middleware behavior while also serving the UI shell and its static assets.

#### Scenario: Dev server exposes UI shell

- **WHEN** the local dev server is running through the existing root `npm run dev` entry point
- **THEN** a browser request for the UI root MUST return an HTML shell that loads the React application
- **AND** `GET /health` MUST continue to return the existing health response

#### Scenario: Production assets are served by Express

- **WHEN** the frontend has been built for production
- **THEN** the Express application MUST serve the generated static assets without requiring a second HTTP server

#### Scenario: UI server starts without worker auth

- **WHEN** the HTTP server starts without Claude worker credentials configured
- **THEN** the server MUST still bind its configured port and serve `/health`, the UI shell, and read-only ticket activity API routes
- **AND** Claude worker credential validation MUST remain enforced only on worker or container-launch paths that actually execute agent work

### Requirement: API Uses Temporal As Source Of Truth

The backend ticket activity API SHALL derive workflow lists, workflow details, current phase, attempt count, review round, activity timeline, terminal result, and failure information only from Temporal APIs and the existing `PerTicketWorkflow` query handlers. The API MUST NOT read from a Furnace database, Linear API, or GitHub API to enrich dashboard responses.

#### Scenario: Ticket workflow list is Temporal-backed

- **WHEN** the UI requests the ticket workflow list
- **THEN** the backend MUST query Temporal visibility for `perTicketWorkflow` executions when workflow-type filtering is supported
- **AND** it MUST fall back to bounded list-all scanning with client-side workflow-type filtering when the local Temporal cluster does not support the typed visibility query
- **AND** the response MUST be constructed from Temporal list, describe, history, result, and query data only

#### Scenario: Ticket workflow detail is Temporal-backed

- **WHEN** the UI requests details for a workflow id and optional run id
- **THEN** the backend MUST fetch the workflow description and history from Temporal
- **AND** any current phase, attempt count, or current round values MUST come from existing workflow queries when those queries are available

#### Scenario: No external enrichment occurs

- **WHEN** the ticket activity API handles any request
- **THEN** it MUST NOT call Linear or GitHub clients
- **AND** it MUST NOT require any application database connection

### Requirement: API Lists Ticket Workflow Summaries

The system SHALL expose a read-only API endpoint that returns recent ticket workflow summaries. Each summary SHALL include workflow identity, Temporal run identity, Temporal execution status, start/close timestamps when available, ticket identity when recoverable from Temporal history, target repo slug when recoverable from Temporal history, and best-effort current phase, attempt count, current round, terminal failure, and PR reference.

#### Scenario: Recent workflows are summarized

- **WHEN** a client calls the workflow summary endpoint
- **THEN** the response MUST contain an array of workflow summaries ordered with the newest executions first
- **AND** each summary MUST include `workflowId`, `runId`, and `status`

#### Scenario: Running workflow includes query state

- **WHEN** a listed workflow is running and its query handlers respond
- **THEN** its summary MUST include `phase`, `attemptCount`, and `currentRound` values from the workflow query handlers

#### Scenario: Running workflow can include PR reference

- **WHEN** a running workflow history contains a completed `openPullRequestActivity` event
- **THEN** its summary MUST include the workflow-recorded PR number and URL from that activity result when those values can be decoded

#### Scenario: Query failure does not hide workflow

- **WHEN** a workflow query is rejected, unavailable, or invalid for the workflow state
- **THEN** the workflow MUST still appear in the summary response
- **AND** fields that could not be queried MUST be omitted or marked unknown rather than fabricated

### Requirement: API Returns Chronological Ticket Activity Detail

The system SHALL expose a read-only API endpoint for a single ticket workflow that returns a normalized chronological timeline from Temporal history. The timeline SHALL include workflow lifecycle events, phase activity scheduling/completion/failure, worker container launch activity, Linear state sync activity, GitHub PR/review activities, cancellation signals, retries, and terminal workflow outcomes when those events are present in Temporal history.

#### Scenario: Timeline preserves event order

- **WHEN** a client requests a workflow detail
- **THEN** the response MUST include timeline events sorted by Temporal event timestamp and event id
- **AND** each timeline event MUST include a stable id, timestamp when available, type, label, and status

#### Scenario: Known Furnace activities are classified

- **WHEN** the Temporal history contains known activity types such as `runSpecPhase`, `runCoderPhase`, `runReviewPhase`, `launchWorkerContainer`, `syncLinearTicketStateActivity`, `openPullRequestActivity`, or `postPullRequestReviewActivity`
- **THEN** the timeline MUST classify those events into their corresponding phase or integration category

#### Scenario: Unknown events remain visible

- **WHEN** the Temporal history contains an event or activity type the normalizer does not recognize
- **THEN** the detail response MUST include a generic timeline entry for that event instead of dropping it

### Requirement: Human Pauses And Review Attempts Are Highlighted

The ticket workflow detail response SHALL identify human-pause and review-attempt information recorded in Temporal history. Human pauses SHALL include AC clarification, dependency-missing, design-question, and review-round-cap failures when their failure types are present. Review attempts SHALL be grouped by review round when round data can be derived from Temporal queries, activity inputs, or event ordering.

#### Scenario: Clarification pause is surfaced

- **WHEN** a workflow history or terminal failure contains an `AcClarificationRequested` failure with sub-ticket detail
- **THEN** the detail response MUST include a human-pause item with type `ac-clarification`
- **AND** the item MUST include the sub-ticket id, identifier, and title when those fields are present in Temporal failure details

#### Scenario: Coder stuck pause is surfaced

- **WHEN** a workflow history or terminal failure contains a `DepMissingRequested` or `DesignQuestionRequested` failure with sub-ticket detail
- **THEN** the detail response MUST include a human-pause item with type `dep-missing` or `design-question`
- **AND** the item MUST include the sub-ticket id, identifier, and title when those fields are present in Temporal failure details

#### Scenario: Review cap exhaustion is surfaced

- **WHEN** a workflow fails with `ReviewRoundCapExhausted`
- **THEN** the detail response MUST include a terminal failure item that exposes the last verdict, reasoning, findings, and PR number when those fields are present in Temporal failure details

#### Scenario: Review rounds are grouped

- **WHEN** the workflow history contains one or more `runReviewPhase` attempts
- **THEN** the detail response MUST include review-round summaries ordered by round index
- **AND** each round summary MUST include verdict, reasoning, findings count, and PR post status when those values are present in Temporal history

### Requirement: UI Clearly Shows Status And Activity Path

The React UI SHALL render a read-only operational view that makes the current status and activity path of a selected ticket workflow visible without requiring the operator to inspect raw Temporal history. The UI SHALL include workflow filtering/listing, selected workflow status, phase path timeline, review attempts, human pauses, terminal outcome, and a Temporal Web deep link when a link can be constructed.

#### Scenario: Selected workflow shows core status

- **WHEN** an operator selects a workflow from the list
- **THEN** the UI MUST display ticket identifier/title when available, workflow id, run id, target repo when available, Temporal status, phase when available, attempt count when available, current round when available, and PR link when available

#### Scenario: Selected workflow shows activity path

- **WHEN** a selected workflow detail response contains timeline events
- **THEN** the UI MUST render those events in chronological order with visual distinction between pending, running, completed, failed, cancelled, and unknown states

#### Scenario: Human pause is visible

- **WHEN** a selected workflow detail response contains one or more human-pause items
- **THEN** the UI MUST render those items prominently enough that they are visible without expanding raw timeline events

#### Scenario: Review attempts are visible

- **WHEN** a selected workflow detail response contains review-round summaries
- **THEN** the UI MUST render review attempts grouped by round and include verdict or failure details when present

### Requirement: UI Remains Read-Only And Fresh

The ticket activity UI SHALL remain read-only and SHALL refresh data without mutating workflow, Linear, or GitHub state. The UI SHALL provide manual refresh and SHALL poll running workflow details at a conservative interval.

#### Scenario: No mutating controls are exposed

- **WHEN** the UI renders workflow list or detail views
- **THEN** it MUST NOT expose controls that signal, cancel, terminate, retry, merge, approve, answer, or otherwise mutate external systems

#### Scenario: Running workflow refreshes

- **WHEN** the selected workflow is running
- **THEN** the UI MUST refresh its detail data automatically at a conservative interval
- **AND** the operator MUST be able to manually refresh the data

#### Scenario: Closed workflow does not poll continuously

- **WHEN** the selected workflow is in a terminal state
- **THEN** the UI MUST stop automatic detail polling for that workflow
- **AND** manual refresh MUST remain available

### Requirement: API Reports Temporal Availability Errors

The ticket activity API SHALL report Temporal connection and lookup failures with explicit JSON errors. Temporal connection failures SHALL return HTTP `503`, missing workflow executions SHALL return HTTP `404`, and invalid request parameters SHALL return HTTP `400`.

#### Scenario: Temporal unavailable returns service unavailable

- **WHEN** Temporal cannot be reached while handling a ticket activity API request
- **THEN** the API MUST return HTTP `503` with a JSON error response

#### Scenario: Missing workflow returns not found

- **WHEN** a client requests a workflow id or run id that Temporal does not know
- **THEN** the API MUST return HTTP `404` with a JSON error response

#### Scenario: Invalid parameters return bad request

- **WHEN** a client passes an invalid limit, status filter, workflow id, or run id
- **THEN** the API MUST return HTTP `400` with a JSON error response
