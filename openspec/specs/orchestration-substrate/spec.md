# orchestration-substrate Specification

## Purpose

Defines the Temporal runtime substrate: client bootstrap, long-lived orchestrator worker registration, ephemeral container worker separation, local Temporal compose services, and smoke-workflow coverage.

## Requirements

### Requirement: Temporal client bootstrap is available to runtime code

The system SHALL expose a Temporal client factory in `server/src/temporal/client.ts` that connects to the configured Temporal frontend endpoint and namespace, and returns a reusable `@temporalio/client` handle for workflow operations.

#### Scenario: Client connects with default local configuration

- **WHEN** the client factory is called with no overriding environment variables in local development
- **THEN** it connects to `localhost:7233` using the default namespace and returns a client object that can start workflows

#### Scenario: Client honors explicit endpoint and namespace

- **WHEN** `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` are set
- **THEN** the client factory connects using those values instead of local defaults

### Requirement: Temporal worker process registers workflows and activities

The system SHALL operate two distinct Temporal worker classes that share a single source tree but register disjoint subsets of workflows and activities:

- **Orchestrator worker** (long-lived) — `server/src/temporal/worker.ts`. Registers all workflow modules (`linear-poller`, `per-ticket`, `hello`) and orchestrator-only activities (Linear, ticket state sync, `launchWorkerContainer`). Listens on the orchestrator task queue configured via `TEMPORAL_TASK_QUEUE`. One process per orchestrator deployment.
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

### Requirement: Claude-facing activities are rate limited at the activity worker level

The system SHALL configure worker activity execution limits so Claude SDK activities cannot exceed a fixed concurrent count per worker process, with configuration documented inline to explain shared subscription constraints.

#### Scenario: Concurrency limit is enforced under load

- **WHEN** more Claude-designated activities are scheduled concurrently than the configured limit
- **THEN** only up to the limit run at once and remaining activities wait in queue without failing solely due to local concurrency pressure

#### Scenario: Rate-limit rationale is documented next to config

- **WHEN** a developer reads the worker activity concurrency configuration
- **THEN** they can see an inline explanation tying the limit to shared Claude subscription quota and starvation prevention

### Requirement: Local Temporal stack is available through docker compose

The system SHALL provide a root-level `docker-compose.yml` that starts a local Temporal service and Temporal UI for development with stable ports.

#### Scenario: Compose starts Temporal frontend on expected port

- **WHEN** `docker compose up` is run from the repository root
- **THEN** Temporal frontend is reachable on `localhost:7233`

#### Scenario: Compose starts Temporal UI on expected port

- **WHEN** the compose stack is running
- **THEN** Temporal Web UI is reachable on `http://localhost:8233`

### Requirement: Smoke workflow validates Temporal round-trip without agent logic

The system SHALL include a smoke workflow (`HelloWorkflow`) and a simple activity implementation that validate client -> workflow -> activity -> result round-trip behavior independent of Linear or Claude integrations.

#### Scenario: Smoke workflow returns expected activity result

- **WHEN** the smoke workflow is started via the Temporal client against a running local worker
- **THEN** the workflow completes successfully and returns the deterministic hello payload produced by the activity

#### Scenario: Smoke workflow is executable in automated tests

- **WHEN** `npm test` is run from the repository root with Temporal services available
- **THEN** at least one integration test executes the smoke workflow end-to-end and fails if worker registration or workflow/activity wiring is broken
