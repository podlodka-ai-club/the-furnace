## ADDED Requirements

### Requirement: Open Pull Request Activity Accepts Implementation Plan Input

The `openPullRequestActivity` input schema SHALL include a required `implementationPlan` field whose shape matches the `implementationPlan` field on `specPhaseOutputSchema`. The per-ticket workflow SHALL forward `specOutput.implementationPlan` into this field on the round-0 invocation.

#### Scenario: Activity input carries the implementation plan

- **WHEN** the workflow invokes `openPullRequestActivity` after a successful round-0 coder phase
- **THEN** the input MUST include `implementationPlan` equal to `specOutput.implementationPlan`
- **AND** the input schema MUST reject calls that omit the field

#### Scenario: Plan is sourced from workflow state, not GitHub or the container

- **WHEN** the activity composes its inputs
- **THEN** the plan MUST be sourced from the workflow-supplied input
- **AND** the activity MUST NOT read the plan from the target repo's working tree, the open PR, or any other side channel

## MODIFIED Requirements

### Requirement: Pull Request Body Contains Ticket Context, Diff Summary, Workflow Link, And Metadata Block

The pull request body SHALL include, in order: the ticket description verbatim, an `## Implementation plan` section rendered from the supplied `implementationPlan`, a one-line diff summary derived from the supplied `diffSummary`, a link to the Temporal workflow execution, and a fenced metadata block delimited by `<!-- furnace:metadata -->` and `<!-- /furnace:metadata -->` HTML comments.

The metadata block SHALL contain one `Key: Value` line per field, with the keys `Workflow-Id`, `Ticket-Id`, `Ticket-Identifier`, `Attempt-Count`, `Model`, and `Final-Commit`.

#### Scenario: Body includes ticket description and diff summary

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain the ticket description verbatim
- **AND** the body MUST contain a one-line diff summary derived from the supplied `diffSummary`

#### Scenario: Body includes implementation plan section

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain exactly one `## Implementation plan` heading, emitted by the shared plan-Markdown formatter
- **AND** that section MUST appear after the ticket description and before the diff summary
- **AND** the body composer MUST NOT add a separate `## Implementation plan` heading around the formatter's output
- **AND** the rendered Markdown MUST be a deterministic function of the input plan (same plan → byte-identical Markdown)

#### Scenario: Body links to Temporal workflow execution

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain a hyperlink to the workflow execution constructed via the existing workflow deep-link helper

#### Scenario: Metadata block is machine-parseable

- **WHEN** the activity composes the PR body
- **THEN** the body MUST contain exactly one block delimited by `<!-- furnace:metadata -->` and `<!-- /furnace:metadata -->`
- **AND** the block MUST contain `Workflow-Id: <workflowId>`
- **AND** the block MUST contain `Ticket-Id: <ticket.id>`
- **AND** the block MUST contain `Ticket-Identifier: <ticket.identifier>`
- **AND** the block MUST contain `Attempt-Count: <attemptCount>`
- **AND** the block MUST contain `Model: <model>`
- **AND** the block MUST contain `Final-Commit: <finalCommitSha>`
