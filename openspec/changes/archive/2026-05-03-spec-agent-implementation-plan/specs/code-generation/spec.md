## ADDED Requirements

### Requirement: Coder Prompt Incorporates Spec Phase Implementation Plan

The coder activity SHALL render the spec phase's `implementationPlan` into a dedicated section of the coder prompt, placed above the failing-tests block. The agent SHALL be instructed to satisfy both the failing tests and the plan items, treating the tests as the hard verification contract and the plan as the soft scope contract.

#### Scenario: Plan section rendered above tests

- **WHEN** the coder activity instantiates the SDK conversation
- **THEN** the prompt MUST contain exactly one `## Implementation plan` heading, emitted by the shared plan-Markdown formatter
- **AND** that heading MUST appear above the existing `## Failing tests committed by the spec agent` section
- **AND** the plan section MUST include the spec agent's `summary` verbatim
- **AND** the plan section MUST list every work item, grouped by `area`, annotated `(test-covered)` when `coveredByTests === true` and `(plan-only)` when `coveredByTests === false`

#### Scenario: Prompt instructs agent to satisfy both tests and plan

- **WHEN** the coder prompt is rendered
- **THEN** the prompt MUST instruct the agent that satisfying the failing tests is required AND that every plan item must also be honored
- **AND** the prompt MUST instruct the agent that an unresolvable `(plan-only)` item MUST be escalated via `report_design_question` rather than silently skipped

#### Scenario: Plan section is sourced from workflow input

- **WHEN** the coder activity renders the plan into the prompt
- **THEN** it MUST read the plan from `input.specOutput.implementationPlan`
- **AND** it MUST NOT read any plan-bearing file from the working tree to construct the prompt

## MODIFIED Requirements

### Requirement: Coder Activity Drives Claude Agent SDK Inside Container

The coder phase activity SHALL invoke the Claude Agent SDK from inside the per-ticket worker container to make the spec phase's failing tests pass on the same feature branch, using the in-container working tree as the agent's filesystem and the bind-mounted `~/.claude` credentials for subscription auth. The activity SHALL render the ticket title and description, the spec phase's feature branch and test paths, AND the spec phase's implementation plan into the prompt before the SDK conversation begins.

#### Scenario: Activity runs SDK in container

- **WHEN** `runCoderPhase` is invoked on the per-repo container worker
- **THEN** it MUST load the prompt file at runtime from `server/src/agents/coder/prompt.md`
- **AND** it MUST instantiate the Claude Agent SDK with the loaded prompt, the ticket title and description received in input, the spec phase's feature branch and test paths interpolated into the prompt, and the spec phase's implementation plan rendered into the prompt
- **AND** the SDK conversation MUST execute inside the container, not on the orchestrator host

#### Scenario: Prompt is reloaded each invocation

- **WHEN** the coder activity body starts
- **THEN** the prompt file MUST be read via `fs.readFile` at activity entry, not cached at module import time
