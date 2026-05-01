# code-generation Specification

## Purpose

Defines how the coder phase activity runs a Claude Agent SDK implementation loop to turn spec-phase failing tests into green tests, including retry ephemerality, attempt persistence, typed stuck escalation, and diff-manifest output for downstream review.

## Requirements

### Requirement: Coder Phase Iterates Failing Tests To Green

The system SHALL implement `runCoderPhase` as a Claude Agent SDK-driven loop that checks out the spec-produced feature branch, reads failing tests, edits code, reruns tests, and creates a commit only after the test suite passes.

#### Scenario: Coder loop produces green commit

- **WHEN** the coder phase starts with a valid spec phase output and failing tests
- **THEN** it MUST checkout the target feature branch inside the worker container
- **AND** it MUST iterate code edits and test execution until tests pass or attempt budget is exhausted
- **AND** it MUST create a commit on the feature branch only after tests are green

### Requirement: Coder Retries Use Fresh Ephemeral Environment

Each coder attempt SHALL execute in a fresh pre-warmed ephemeral container so retry attempts do not reuse mutated workspace state from prior attempts.

#### Scenario: Retry starts from clean state

- **WHEN** Temporal schedules a retry attempt for the coder phase
- **THEN** the worker MUST provision a fresh container instance for that attempt
- **AND** the attempt MUST re-checkout the target branch before applying edits

### Requirement: Coder Persists Attempt Outcomes

The coder phase SHALL persist one `attempts` row per iteration with normalized outcomes: `tests-green`, `retry`, `dep-missing`, or `design-question`.

#### Scenario: Attempt row is written on each iteration

- **WHEN** a coder iteration ends with test success, retryable failure, or typed stuck classification
- **THEN** the system MUST write exactly one `attempts` record for that iteration
- **AND** the recorded outcome MUST be one of the canonical coder outcomes

### Requirement: Typed Stuck Conditions Escalate Via Sub-Tickets

The coder phase SHALL classify persistent blockers as either `dep-missing` or `design-question`, open the matching Linear sub-ticket with workflow deep-link context, and fail the activity as non-retryable.

#### Scenario: Dependency blocker escalates

- **WHEN** coder determines progress is blocked by a missing dependency
- **THEN** it MUST create a `dep-missing` sub-ticket linked to the parent workflow context
- **AND** it MUST fail `runCoderPhase` with a non-retryable failure carrying the sub-ticket reference

#### Scenario: Design ambiguity escalates

- **WHEN** coder determines progress is blocked by unresolved design ambiguity
- **THEN** it MUST create a `design-question` sub-ticket linked to the parent workflow context
- **AND** it MUST fail `runCoderPhase` with a non-retryable failure carrying the sub-ticket reference

### Requirement: Coder Emits Diff Manifest For Review

On successful completion, the coder phase SHALL return a diff manifest that identifies the committed changes for downstream review.

#### Scenario: Review receives committed change context

- **WHEN** coder completes with tests green
- **THEN** `runCoderPhase` MUST return a structured diff manifest derived from the committed branch state
- **AND** the returned payload MUST be sufficient for the review phase to evaluate changed files and commit context
