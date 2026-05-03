# spec-generation Specification

## Purpose

Defines how the spec phase activity drives the Claude Agent SDK inside the per-ticket worker container to translate Linear tickets into failing-test commits, including agent tool surface, verification, branch/commit hygiene, clarification handling, heartbeating, and contract validation.

## Requirements

### Requirement: Spec Activity Drives Claude Agent SDK Inside Container

The spec phase activity SHALL invoke the Claude Agent SDK from inside the per-ticket worker container to translate a Linear ticket into failing tests, using the in-container working tree as the agent's filesystem and the bind-mounted `~/.claude` credentials for subscription auth.

#### Scenario: Activity runs SDK in container

- **WHEN** `runSpecPhase` is invoked on the per-repo container worker
- **THEN** it MUST load the prompt file at runtime from `server/src/agents/spec/prompt.md`
- **AND** it MUST instantiate the Claude Agent SDK with the loaded prompt and the ticket title and description fetched from the `tickets` table
- **AND** the SDK conversation MUST execute inside the container (not on the orchestrator host)

#### Scenario: Prompt is reloaded each invocation

- **WHEN** the spec activity body starts
- **THEN** the prompt file MUST be read via `fs.readFile` at activity entry, not cached at module import time

### Requirement: Agent Exposes Exactly Two Decision Tools

The spec agent SHALL be given exactly two custom tools — `propose_failing_tests` and `request_ac_clarification` — and MUST commit to one of them as its terminal action. Free-form prose without a tool call SHALL be treated as a model failure. The `propose_failing_tests` tool's argument schema SHALL require both the failing test files AND a structured implementation plan.

#### Scenario: Agent proposes failing tests with plan

- **WHEN** the agent calls `propose_failing_tests({ files: [{ path, contents, description }, …], implementationPlan: { summary, workItems } })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to write each test file, verify failure, commit each test file, push the branch, and return the plan in the `SpecPhaseOutput`

#### Scenario: Agent requests AC clarification

- **WHEN** the agent calls `request_ac_clarification({ reason, questions })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to open a Linear sub-ticket and fail non-retryably

#### Scenario: Agent returns prose without tool call

- **WHEN** the agent ends its turn without calling either tool
- **THEN** the activity MUST send a corrective message instructing the agent to pick a tool
- **AND** the activity MUST allow up to 3 such corrections within the same SDK conversation
- **AND** if the budget is exhausted, the activity MUST throw a retryable error so Temporal launches a fresh container

### Requirement: Spec Agent Produces Implementation Plan Atomically With Failing Tests

The spec agent SHALL produce an implementation plan in the same terminal `propose_failing_tests` tool call that submits the failing test files. The plan SHALL be a structured object with a free-form summary and a flat list of work items, each tagged with an area and a flag indicating whether the failing tests already cover that item. The activity SHALL NOT accept a `propose_failing_tests` call that omits the plan.

#### Scenario: Plan accompanies failing tests

- **WHEN** the spec agent calls `propose_failing_tests({ files, implementationPlan })`
- **THEN** the activity MUST validate `implementationPlan` against the implementation-plan schema (summary string, non-empty array of work items, each with `area`, `description`, `coveredByTests`)
- **AND** the activity MUST proceed with the existing test verification flow as a single logical submission

#### Scenario: Missing plan is rejected as malformed input

- **WHEN** the spec agent calls `propose_failing_tests` without an `implementationPlan` argument, or with one that fails schema validation
- **THEN** the activity MUST treat the call as a malformed tool call and send a corrective message instructing the agent to re-call the tool with a valid plan
- **AND** the correction MUST count against the existing correction budget shared with prose-only and false-failing-test corrections

#### Scenario: Work-item areas are constrained

- **WHEN** the implementation plan is validated
- **THEN** each work item's `area` field MUST be one of `"backend" | "frontend" | "config" | "migration" | "docs" | "other"`
- **AND** any other value MUST cause schema parsing to fail

### Requirement: Spec Agent Surfaces Plan Ambiguity Through Existing Clarification Tool

If the spec agent cannot articulate a coherent implementation plan from the ticket — even if it could write a partial test — it SHALL call `request_ac_clarification` rather than submit a partial plan. Plan ambiguity SHALL NOT introduce a new clarification tool; it reuses the AC-clarification path.

#### Scenario: Plan-blocked ticket reuses AC clarification

- **WHEN** the spec agent determines it cannot produce both a failing test AND a coherent plan from the ticket
- **THEN** it MUST call `request_ac_clarification({ reason, questions })`
- **AND** the activity MUST handle that call exactly as it handles any other AC clarification (open a Linear sub-ticket of type `ac-clarification`, throw `AcClarificationRequested`)

### Requirement: Implementation Plan Is Returned In SpecPhaseOutput

The activity SHALL include `implementationPlan` as a required field on the value it returns to the workflow. The plan SHALL NOT be persisted as a file in the target repo's working tree, and the activity SHALL NOT create any commit other than the per-test-file commits already required by the existing branch-and-commit flow.

#### Scenario: Output carries the plan verbatim

- **WHEN** the spec activity completes the push successfully
- **THEN** the returned object MUST include `implementationPlan` equal to the value the agent submitted in `propose_failing_tests`
- **AND** the returned object MUST parse against `specPhaseOutputSchema`

#### Scenario: Activity does not write plan into the target repo

- **WHEN** the spec activity runs successfully
- **THEN** it MUST NOT write any file outside of the proposed test paths into the target repo working tree
- **AND** it MUST NOT create any commit beyond the per-test-file commits

### Requirement: Activity Verifies Proposed Tests Actually Fail

After `propose_failing_tests` returns, the activity itself SHALL run the repo's declared test command and confirm that the proposed tests fail before committing them. The agent's claim about pass/fail SHALL NOT be trusted.

#### Scenario: Proposed tests fail as expected

- **WHEN** the activity has written the proposed test files and runs the repo's test command
- **THEN** it MUST observe at least one of the new test files failing
- **AND** it MUST proceed to commit and push the feature branch

#### Scenario: Proposed tests pass on main

- **WHEN** the activity runs the repo's test command and one or more proposed tests pass
- **THEN** the activity MUST send a corrective message to the agent identifying which tests passed
- **AND** it MUST request replacement tests within the same SDK conversation, capped at the same correction budget
- **AND** if the budget is exhausted, the activity MUST throw a retryable error

#### Scenario: Test command resolution

- **WHEN** the activity prepares to run the repo's tests
- **THEN** it MUST read the test command from the repo's `package.json` `"scripts.test"` field if present
- **AND** it MUST fall back to `npm test` if no script is declared

### Requirement: One Commit Per Test File On Feature Branch

The activity SHALL create a feature branch named `agent/spec-<ticket-identifier-lowercased>` from the repo's default branch, write each proposed test file in turn, and commit each as its own commit before pushing the branch to `origin --set-upstream`.

#### Scenario: Per-file commit on fresh branch

- **WHEN** the activity has verified that proposed tests fail
- **THEN** it MUST create a feature branch named `agent/spec-<ticket-identifier-lowercased>` from the default branch
- **AND** it MUST commit each test file as a separate commit
- **AND** each commit message MUST include a structured trailer with `Workflow-Id`, `Ticket-Id`, `Attempt`, and `Phase: spec`

#### Scenario: Branch is pushed to origin

- **WHEN** all per-file commits have landed locally
- **THEN** the activity MUST push the feature branch to `origin` with `--set-upstream`
- **AND** if the push fails, the activity MUST throw a retryable error so Temporal retries on a fresh container

#### Scenario: Activity returns SpecPhaseOutput

- **WHEN** the spec activity completes the push
- **THEN** it MUST return a value that parses against `specPhaseOutputSchema`
- **AND** the output MUST include the feature branch name and the list of test commit SHAs

### Requirement: AC Clarification Opens Sub-Ticket and Fails Non-Retryably

When the agent calls `request_ac_clarification`, the activity SHALL open a Linear sub-ticket of type `ac-clarification` against the ticket and SHALL throw a non-retryable `ApplicationFailure` so Temporal does not loop the same prompt.

#### Scenario: Sub-ticket creation succeeds

- **WHEN** the agent calls `request_ac_clarification({ reason, questions })`
- **THEN** the activity MUST call `linearClient.createSubTicket(parentId, "ac-clarification", body, workflowDeepLink)` where `body` formats `questions` as a checklist
- **AND** `workflowDeepLink` MUST point to the Temporal Web URL for the current workflow run, derived from the `TEMPORAL_WEB_BASE` env var
- **AND** the activity MUST throw `ApplicationFailure.nonRetryable` of type `AcClarificationRequested` carrying the sub-ticket reference (`{ id, identifier, title }`) as failure detail

#### Scenario: Sub-ticket creation fails (Linear outage)

- **WHEN** `createSubTicket` throws because Linear is unreachable
- **THEN** the activity MUST throw a *retryable* error
- **AND** Temporal MUST be allowed to retry the entire spec phase

### Requirement: Activity Heartbeats On Schedule

The spec activity SHALL heartbeat at a cadence that fits within the workflow's `heartbeatTimeout` of 30 seconds, including during long-running tool executions, so cooperative cancellation is honored.

#### Scenario: Heartbeat at start

- **WHEN** the spec activity begins
- **THEN** it MUST call `Context.heartbeat()` before invoking the SDK

#### Scenario: Heartbeat during SDK conversation

- **WHEN** the SDK conversation is in flight
- **THEN** the activity MUST heartbeat at least every 5 seconds via a `setInterval`
- **AND** the interval MUST be cleared in a `finally` block on activity exit

#### Scenario: Heartbeat before long tool runs

- **WHEN** the activity is about to run the test command, push the branch, or perform any operation that may exceed 5 seconds
- **THEN** it MUST heartbeat immediately before that operation

### Requirement: Activity Validates Input and Output Against Contract Schemas

The spec activity SHALL validate its input via `specPhaseInputSchema.parse(input)` at entry and its output via `specPhaseOutputSchema.parse(output)` before return, regardless of whether the body is a real implementation or a no-op.

#### Scenario: Invalid input

- **WHEN** the activity is invoked with input that fails `specPhaseInputSchema.parse`
- **THEN** it MUST throw a non-retryable `ApplicationFailure` with type `InvalidSpecPhaseInput`

#### Scenario: Invalid output

- **WHEN** the activity is about to return a value that fails `specPhaseOutputSchema.parse`
- **THEN** it MUST throw rather than return so the workflow does not see a malformed payload

### Requirement: Repo Path Inside Container Is Configurable

The activity SHALL determine the repo working tree location inside the container from the `WORKER_REPO_PATH` environment variable, defaulting to `/workspace` when unset, and SHALL pass that path into the agent's tool descriptions.

#### Scenario: Default repo path

- **WHEN** `WORKER_REPO_PATH` is unset in the container
- **THEN** the activity MUST treat `/workspace` as the repo root for both git operations and the agent's tool prompt

#### Scenario: Override via env var

- **WHEN** `WORKER_REPO_PATH` is set to a non-default value
- **THEN** the activity MUST use that path for git operations and reflect it in tool prompts the agent receives
