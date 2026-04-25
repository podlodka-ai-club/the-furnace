# agent-io-contracts Specification

## Purpose

Defines a single, canonical set of inter-agent I/O contracts so spec, coder, and reviewer phases share one runtime-validated and statically inferred source of truth.

## Requirements

### Requirement: Canonical Inter-Agent Contract Registry

The system SHALL define a single canonical registry of inter-agent I/O contracts under `server/src/agents/contracts/` covering spec phase output, coder phase output, reviewer input, reviewer result, and shared primitives used across those boundaries.

#### Scenario: Contract modules are discoverable from one entrypoint

- **WHEN** a phase activity imports pipeline contracts
- **THEN** it SHALL be able to import all contract schemas and inferred types from `server/src/agents/contracts/index.ts`

### Requirement: Runtime Validation at Phase Boundaries

Each phase activity SHALL validate its input payload on entry and its output payload before return using the corresponding canonical Zod schema.

#### Scenario: Invalid inbound payload fails activity

- **WHEN** a phase activity receives a payload that does not conform to its input schema
- **THEN** `schema.parse()` MUST throw and the activity MUST fail without passing the payload downstream

#### Scenario: Invalid outbound payload fails activity

- **WHEN** a phase activity attempts to return a payload that does not conform to its output schema
- **THEN** `schema.parse()` MUST throw and the activity MUST fail before returning malformed data

### Requirement: Shared Runtime and Static Contract Source

Each inter-agent payload contract SHALL be defined once as a Zod schema and SHALL export its TypeScript type via `z.infer` from the same module.

#### Scenario: Inferred type and runtime schema stay aligned

- **WHEN** a contract field is added, removed, or changed in a schema
- **THEN** the inferred TypeScript type SHALL reflect the same change without manual interface updates

### Requirement: Contract Fixture Validation Tests

The test suite SHALL include positive and negative fixture tests for each inter-agent contract, where valid fixtures parse successfully and invalid fixtures throw.

#### Scenario: Valid fixtures parse successfully

- **WHEN** contract tests execute with canonical valid fixtures
- **THEN** `schema.parse(validFixture)` SHALL succeed for every inter-agent contract

#### Scenario: Invalid fixtures are rejected

- **WHEN** contract tests execute with canonical invalid fixtures
- **THEN** `schema.parse(invalidFixture)` SHALL throw for every inter-agent contract
