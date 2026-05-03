## ADDED Requirements

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

## MODIFIED Requirements

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
