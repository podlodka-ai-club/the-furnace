## ADDED Requirements

### Requirement: Coder Activity Drives Claude Agent SDK Inside Container

The coder phase activity SHALL invoke the Claude Agent SDK from inside the per-ticket worker container to make the spec phase's failing tests pass on the same feature branch, using the in-container working tree as the agent's filesystem and the bind-mounted `~/.claude` credentials for subscription auth.

#### Scenario: Activity runs SDK in container

- **WHEN** `runCoderPhase` is invoked on the per-repo container worker
- **THEN** it MUST load the prompt file at runtime from `server/src/agents/coder/prompt.md`
- **AND** it MUST instantiate the Claude Agent SDK with the loaded prompt, the ticket title and description received in input, and the spec phase's feature branch and test paths interpolated into the prompt
- **AND** the SDK conversation MUST execute inside the container, not on the orchestrator host

#### Scenario: Prompt is reloaded each invocation

- **WHEN** the coder activity body starts
- **THEN** the prompt file MUST be read via `fs.readFile` at activity entry, not cached at module import time

### Requirement: Activity Checks Out Spec Feature Branch From Origin

The coder activity SHALL check out the spec phase's feature branch from `origin` inside the per-attempt container before invoking the agent, so the agent operates on the same branch the spec phase produced.

#### Scenario: Feature branch checked out

- **WHEN** the coder activity begins
- **THEN** it MUST run `git fetch origin <featureBranch>` for the branch named in the input's `specOutput.featureBranch`
- **AND** it MUST check the branch out as the active working tree before the SDK conversation starts
- **AND** it MUST verify the working tree is clean before yielding control to the agent

### Requirement: Agent Exposes Three Decision Tools

The coder agent SHALL be given exactly three custom tools — `submit_implementation`, `report_dep_missing`, and `report_design_question` — and MUST commit to one of them as its terminal action. Free-form prose without a tool call SHALL be treated as a model failure.

#### Scenario: Agent submits implementation

- **WHEN** the agent calls `submit_implementation({ summary })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to verify tests, verify test files were not modified, commit, and push

#### Scenario: Agent reports missing dependency

- **WHEN** the agent calls `report_dep_missing({ reason, dependency, questions })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to open a Linear sub-ticket of type `dep-missing` and fail non-retryably

#### Scenario: Agent reports design question

- **WHEN** the agent calls `report_design_question({ reason, questions })`
- **THEN** the activity MUST treat the call as the agent's terminal decision
- **AND** the activity MUST proceed to open a Linear sub-ticket of type `design-question` and fail non-retryably

#### Scenario: Agent returns prose without tool call

- **WHEN** the agent ends its turn without calling any of the three tools
- **THEN** the activity MUST send a corrective message instructing the agent to pick a tool
- **AND** the activity MUST allow up to 3 such corrections within the same SDK conversation
- **AND** if the budget is exhausted, the activity MUST throw a retryable error so Temporal launches a fresh container

### Requirement: Agent Has Iterative Edit and Test Tools Inside the Conversation

The coder agent SHALL be given the SDK's built-in `Read`, `Glob`, `Grep`, `Bash`, `Edit`, and `Write` tools so it can iterate read-tests → edit-production-code → run-tests within a single SDK conversation before calling a terminal tool.

#### Scenario: Built-in tool set

- **WHEN** the activity instantiates the SDK conversation
- **THEN** the configured built-in tools MUST be exactly `Read`, `Glob`, `Grep`, `Bash`, `Edit`, and `Write`
- **AND** no other built-in tools (e.g., network or admin tools) MAY be enabled

### Requirement: Activity Verifies Tests Actually Pass

After `submit_implementation` returns, the activity itself SHALL run the repo's declared test command and confirm that the suite passes (exit code 0) before committing and pushing. The agent's claim that tests are green SHALL NOT be trusted.

#### Scenario: Tests pass on verification

- **WHEN** the activity has run the repo's test command after `submit_implementation`
- **THEN** if the suite exits with code 0 the activity MUST proceed to commit and push the branch

#### Scenario: Tests still fail on verification

- **WHEN** the activity runs the repo's test command and the suite exits non-zero
- **THEN** the activity MUST send a corrective message to the agent identifying that tests still fail and including the runner output tail
- **AND** it MUST request another iteration within the same SDK conversation, capped at the same correction budget shared with prose-only and test-file-modification corrections
- **AND** if the budget is exhausted, the activity MUST throw a retryable error

#### Scenario: Test command resolution

- **WHEN** the activity prepares to run the repo's tests
- **THEN** it MUST read the test command from the repo's `package.json` `"scripts.test"` field if present
- **AND** it MUST fall back to `npm test` if no script is declared

### Requirement: Activity Verifies Test Files Were Not Modified

After `submit_implementation` returns and before committing, the activity SHALL diff the agent's working-tree changes against the spec phase's pre-agent HEAD on the feature branch and SHALL reject the submission if any of the test paths committed by the spec phase appear as modified.

#### Scenario: No spec test files modified

- **WHEN** the activity computes the diff and none of the spec phase's `testCommits[].path` entries are touched
- **THEN** the activity MUST proceed to commit and push

#### Scenario: Spec test file modified

- **WHEN** any spec-phase test path appears in the diff
- **THEN** the activity MUST send a corrective message naming the modified test paths and instructing the agent to revert them and edit only production code
- **AND** it MUST request another iteration within the same SDK conversation, sharing the correction budget with the test-failure correction loop
- **AND** if the budget is exhausted, the activity MUST throw a retryable error

### Requirement: Single Commit Per Attempt On Existing Feature Branch

The activity SHALL commit the agent's accepted changes as a single commit on the spec phase's feature branch with a structured trailer, then push the branch to `origin`. The activity SHALL NOT create a new branch.

#### Scenario: Single commit on the spec feature branch

- **WHEN** the activity has verified that tests pass and that no spec test files were modified
- **THEN** it MUST stage the agent's working-tree changes
- **AND** it MUST create exactly one commit on the spec phase's feature branch
- **AND** the commit subject MUST identify the ticket (e.g., `feat(coder): make spec tests green for <ticket-identifier>`)
- **AND** the commit message MUST include a structured trailer with `Workflow-Id`, `Ticket-Id`, `Attempt`, and `Phase: coder`

#### Scenario: Branch is pushed to origin

- **WHEN** the activity has created the commit locally
- **THEN** it MUST push the branch to `origin`
- **AND** if the push fails, the activity MUST throw a retryable error so Temporal retries on a fresh container

#### Scenario: Activity returns CoderPhaseOutput

- **WHEN** the coder activity completes the push
- **THEN** it MUST return a value that parses against `coderPhaseOutputSchema`
- **AND** the output MUST include the feature branch name, the final commit SHA, the diff stat (files changed, insertions, deletions), and the test run summary (total, passed, failed, durationMs)

### Requirement: Stuck Tools Open Linear Sub-Ticket and Fail Non-Retryably

When the agent calls `report_dep_missing` or `report_design_question`, the activity SHALL open a Linear sub-ticket of the matching type against the parent ticket and SHALL throw a non-retryable `ApplicationFailure` so Temporal does not loop the same prompt.

#### Scenario: Dep-missing sub-ticket creation succeeds

- **WHEN** the agent calls `report_dep_missing({ reason, dependency, questions })`
- **THEN** the activity MUST call `linearClient.createSubTicket(parentId, "dep-missing", body, workflowDeepLink)` where `body` formats `reason`, `dependency`, and `questions` as a Markdown checklist
- **AND** `workflowDeepLink` MUST point to the Temporal Web URL for the current workflow run, derived from the `TEMPORAL_WEB_BASE` env var
- **AND** the activity MUST throw `ApplicationFailure.nonRetryable` of type `DepMissingRequested` carrying the sub-ticket reference (`{ id, identifier, title }`) as failure detail

#### Scenario: Design-question sub-ticket creation succeeds

- **WHEN** the agent calls `report_design_question({ reason, questions })`
- **THEN** the activity MUST call `linearClient.createSubTicket(parentId, "design-question", body, workflowDeepLink)` where `body` formats `reason` and `questions` as a Markdown checklist
- **AND** `workflowDeepLink` MUST point to the Temporal Web URL for the current workflow run, derived from the `TEMPORAL_WEB_BASE` env var
- **AND** the activity MUST throw `ApplicationFailure.nonRetryable` of type `DesignQuestionRequested` carrying the sub-ticket reference as failure detail

#### Scenario: Sub-ticket creation fails (Linear outage)

- **WHEN** `createSubTicket` throws because Linear is unreachable
- **THEN** the activity MUST throw a *retryable* error
- **AND** Temporal MUST be allowed to retry the entire coder phase

### Requirement: Activity Heartbeats On Schedule

The coder activity SHALL heartbeat at a cadence that fits within the workflow's `heartbeatTimeout` of 30 seconds, including during long-running tool executions, so cooperative cancellation is honored.

#### Scenario: Heartbeat at start

- **WHEN** the coder activity begins
- **THEN** it MUST call `Context.heartbeat()` before invoking the SDK

#### Scenario: Heartbeat during SDK conversation

- **WHEN** the SDK conversation is in flight
- **THEN** the activity MUST heartbeat at least every 5 seconds via a `setInterval`
- **AND** the interval MUST be cleared in a `finally` block on activity exit

#### Scenario: Heartbeat before long operations

- **WHEN** the activity is about to run the test command, the diff check, the commit, or the push, or any operation that may exceed 5 seconds
- **THEN** it MUST heartbeat immediately before that operation

### Requirement: Activity Validates Input and Output Against Contract Schemas

The coder activity SHALL validate its input via a `coderPhaseInputSchema.parse(input)` at entry and its output via `coderPhaseOutputSchema.parse(output)` before return.

#### Scenario: Invalid input

- **WHEN** the activity is invoked with input that fails `coderPhaseInputSchema.parse`
- **THEN** it MUST throw a non-retryable `ApplicationFailure` with type `InvalidCoderPhaseInput`

#### Scenario: Invalid output

- **WHEN** the activity is about to return a value that fails `coderPhaseOutputSchema.parse`
- **THEN** it MUST throw rather than return so the workflow does not see a malformed payload

### Requirement: Repo Path Inside Container Is Configurable

The activity SHALL determine the repo working tree location inside the container from the `WORKER_REPO_PATH` environment variable, defaulting to `/workspace` when unset, and SHALL pass that path into the agent's tool descriptions.

#### Scenario: Default repo path

- **WHEN** `WORKER_REPO_PATH` is unset in the container
- **THEN** the activity MUST treat `/workspace` as the repo root for both git operations and the agent's tool prompt

#### Scenario: Override via env var

- **WHEN** `WORKER_REPO_PATH` is set to a non-default value
- **THEN** the activity MUST use that path for git operations and reflect it in tool prompts the agent receives
