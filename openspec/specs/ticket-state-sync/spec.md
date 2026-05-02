# ticket-state-sync Specification

## Purpose

Defines how per-ticket workflow lifecycle transitions synchronize the corresponding Linear issue state through retry-safe Temporal activity boundaries.

## Requirements

### Requirement: Workflow lifecycle updates Linear ticket state

The system SHALL synchronize Linear issue state from per-ticket workflow lifecycle transitions.

#### Scenario: Workflow start moves ticket to In Progress

- **WHEN** `PerTicketWorkflow` begins execution for a ticket
- **THEN** the system MUST request a Linear issue state update for that ticket to the configured `In Progress` state

#### Scenario: Successful review completion moves ticket to Done

- **WHEN** `PerTicketWorkflow` completes all phases successfully
- **THEN** the system MUST request a Linear issue state update for that ticket to the configured `Done` state

#### Scenario: Workflow cancellation moves ticket to Canceled

- **WHEN** `PerTicketWorkflow` ends via `cancel` signal
- **THEN** the system MUST request a Linear issue state update for that ticket to the configured `Canceled` state

### Requirement: State sync uses retry-safe activity boundaries

The system SHALL execute Linear ticket state updates through Temporal activities so failures are retried with standard activity retry semantics.

#### Scenario: Transient Linear failure is retried

- **WHEN** a state update activity call fails with a retryable transport or API error
- **THEN** the activity MUST be retried according to configured retry policy before the workflow proceeds past the transition point

#### Scenario: Successful update remains idempotent across retries

- **WHEN** a retried activity repeats an already-applied target state update
- **THEN** the workflow MUST continue without duplicate terminal side effects or inconsistent local status
