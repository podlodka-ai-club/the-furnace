## MODIFIED Requirements

### Requirement: Temporal worker process registers workflows and activities

The system SHALL operate two distinct Temporal worker classes that share a single source tree but register disjoint subsets of workflows and activities:

- **Orchestrator worker** (long-lived) — `server/src/temporal/worker.ts`. Registers all workflow modules (`linear-poller`, `per-ticket`, `hello`) and orchestrator-only activities (Linear, workflow-run persistence, `launchWorkerContainer`). Listens on the orchestrator task queue configured via `TEMPORAL_TASK_QUEUE`. One process per orchestrator deployment.
- **Container worker** (ephemeral) — `server/src/worker-entry.ts`. Registers only the phase activities (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`). Listens on the per-repo task queue `repo-${WORKER_REPO}-worker`. One process per attempt; exits after one activity completes.

Phase activity dispatch from workflow code MUST go through a helper (`server/src/temporal/dispatch.ts:phaseActivitiesForRepo`) that binds the activity proxy to `repo-${slug}-worker`, where the slug is derived from the workflow input's `targetRepoSlug`. Phase activities MUST NOT be registered on the orchestrator queue in production; tests MAY inject phase activities on the orchestrator worker for unit-grade coverage.

#### Scenario: Orchestrator worker hosts workflows and orchestrator-only activities

- **WHEN** the orchestrator worker entry point is executed while Temporal server is reachable
- **THEN** a worker process starts, binds to the orchestrator task queue, registers the workflow modules and orchestrator-only activities (including `launchWorkerContainer`), and remains running while polling for work

#### Scenario: Orchestrator worker fails fast on connection errors

- **WHEN** the orchestrator worker starts while the configured Temporal endpoint is unavailable
- **THEN** the process exits non-zero with an error indicating it could not connect to Temporal

#### Scenario: Phase activities dispatch to per-repo queue

- **WHEN** the per-ticket workflow invokes a phase activity with `targetRepoSlug: "demo"`
- **THEN** the activity is scheduled on task queue `repo-demo-worker` and is not visible to workers polling the orchestrator queue

#### Scenario: Orchestrator does not claim phase activities in production

- **WHEN** the orchestrator worker is running in a production configuration and a phase activity is scheduled on `repo-${slug}-worker`
- **THEN** the orchestrator worker does not claim it, because phase activities are not registered on the orchestrator queue
