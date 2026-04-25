# ticket-workflow Specification

## Purpose

Defines typed phase boundaries for the ticket workflow so no-op and future real phase implementations exchange contract-validated payloads.

## Requirements

### Requirement: Typed Phase Activity Boundaries

The ticket workflow SHALL type phase activity interfaces with canonical contract types (`SpecPhaseOutput`, `CoderPhaseOutput`, and `ReviewResult`) instead of untyped or void payloads.

#### Scenario: Workflow phase signatures use contract types

- **WHEN** developers inspect or compile workflow and activity interfaces
- **THEN** the spec, coder, and review phase signatures MUST reference canonical inferred contract types

### Requirement: No-op Phase Implementations Return Valid Contract Shapes

No-op implementations of spec, coder, and review phases SHALL return placeholder payloads that conform to their corresponding contract schemas.

#### Scenario: Placeholder outputs satisfy contract validation

- **WHEN** the no-op phase activities execute in the workflow
- **THEN** each phase output MUST pass its output `schema.parse()` check without schema errors
