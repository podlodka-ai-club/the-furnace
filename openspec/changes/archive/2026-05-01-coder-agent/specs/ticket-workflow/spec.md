## MODIFIED Requirements

### Requirement: Typed Phase Activity Boundaries

The ticket workflow SHALL type phase activity interfaces with canonical contract types (`SpecPhaseOutput`, `CoderPhaseOutput`, and `ReviewResult`) instead of untyped or void payloads, and `CoderPhaseOutput` SHALL represent either a successful diff-manifest result or a typed stuck-with-sub-ticket result.

#### Scenario: Workflow phase signatures use contract types

- **WHEN** developers inspect or compile workflow and activity interfaces
- **THEN** the spec, coder, and review phase signatures MUST reference canonical inferred contract types
- **AND** coder output typing MUST support both successful diff-manifest payloads and typed stuck payloads

### Requirement: No-op Phase Implementations Return Valid Contract Shapes

Review phase implementations that remain as no-op stubs SHALL return placeholder payloads that conform to their corresponding contract schemas. The spec and coder phases no longer fall under this requirement because they have real implementations.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op review phase activity executes in the workflow
- **THEN** the phase output MUST pass its output `schema.parse()` check without schema errors

### Requirement: Per-Ticket Workflow Runs Three Ordered Phases

The system SHALL execute `PerTicketWorkflow` with three phase activities in strict order: `runSpecPhase`, then `runCoderPhase`, then `runReviewPhase`. The spec and coder phases SHALL be real activities, while review may remain a no-op stub until its own change lands.

#### Scenario: Ticket workflow advances through all phases

- **WHEN** a `PerTicketWorkflow` starts for a ticket
- **THEN** it MUST invoke `runSpecPhase` before `runCoderPhase`
- **AND** it MUST invoke `runCoderPhase` before `runReviewPhase`
- **AND** the spec phase MUST execute the real Claude-Agent-SDK-driven activity body, not a no-op
- **AND** the coder phase MUST execute the real implementation loop that returns either a diff manifest or typed stuck output
- **AND** the review phase MAY remain a no-op stub that logs and returns a contract-shaped placeholder
