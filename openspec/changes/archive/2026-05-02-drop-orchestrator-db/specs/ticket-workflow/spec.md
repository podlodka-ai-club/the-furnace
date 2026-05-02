## REMOVED Requirements

### Requirement: Workflow Records Attempts Row Around Spec Phase

**Reason**: The `attempts` table is being deleted along with the rest of the orchestrator database; there is no row to write. Temporal's workflow history already records each spec-phase attempt and its outcome (success, `AcClarificationRequested` non-retryable failure, or generic failure), and `PerTicketWorkflow` continues to expose `currentPhase` and `attemptCount` as Temporal queries for ad-hoc inspection.

**Migration**: The `recordAttempt` orchestrator activity and its call sites in `PerTicketWorkflow` are deleted. Operators or tests that previously asserted "an `attempts` row exists with outcome=passed/stuck/failed" assert against Temporal workflow history (`workflow describe`, search by `WorkflowExecutionStatus`, or per-workflow query handlers) instead.

### Requirement: Workflow Runs Are Persisted On Start and Phase Transitions

**Reason**: The `workflow_runs` row was a strictly weaker copy of state Temporal already owns: every per-ticket workflow has a Temporal execution record with start time, current status, search attributes, and history events around each phase transition. Persisting an additional row added failure surface (the in-process PGLite init was bricking workflows when its WASM aborted) without producing any signal not already available in Temporal.

**Migration**: The `persistWorkflowRunStart` and `persistWorkflowRunTransition` orchestrator activities and their call sites in `PerTicketWorkflow` are deleted. The workflow's terminal status (succeeded / failed / cancelled) and any structured failure detail (e.g., the sub-ticket attached to an `AcClarificationRequested` failure) are surfaced via Temporal's native completion event and failure payloads, which already carry that information. Operators who previously read `workflow_runs.status` read Temporal Web UI or `temporal workflow describe` instead.
