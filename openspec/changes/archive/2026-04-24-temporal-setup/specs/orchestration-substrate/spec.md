# orchestration-substrate Specification

## ADDED Requirements

### Requirement: Temporal client bootstrap is available to runtime code
The system SHALL expose a Temporal client factory in `server/src/temporal/client.ts` that connects to the configured Temporal frontend endpoint and namespace, and returns a reusable `@temporalio/client` handle for workflow operations.

#### Scenario: Client connects with default local configuration
- **WHEN** the client factory is called with no overriding environment variables in local development
- **THEN** it connects to `localhost:7233` using the default namespace and returns a client object that can start workflows

#### Scenario: Client honors explicit endpoint and namespace
- **WHEN** `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` are set
- **THEN** the client factory connects using those values instead of local defaults

### Requirement: Temporal worker process registers workflows and activities
The system SHALL provide `server/src/temporal/worker.ts` as a worker entry point that creates a `@temporalio/worker` Worker, registers at least one workflow module and one activity module, and runs against a configured task queue.

#### Scenario: Worker starts and polls task queue
- **WHEN** the worker entry point is executed while Temporal server is reachable
- **THEN** a worker process starts, binds to the configured task queue, and remains running while polling for work

#### Scenario: Worker fails fast on connection errors
- **WHEN** the worker starts while the configured Temporal endpoint is unavailable
- **THEN** the process exits non-zero with an error indicating it could not connect to Temporal

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
