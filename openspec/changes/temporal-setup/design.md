## Context

The project currently has an Express runtime and PGLite persistence baseline but no durable orchestrator. The roadmap places `temporal-setup` first in Phase 2 so downstream changes (`linear-integration`, `agent-io-contracts`, `per-ticket-workflow`) can build on stable workflow execution primitives.

Temporal is load-bearing for this system: workflows must survive worker restarts and support queryable execution state. The concept and proposal also impose a strict shared Claude subscription constraint, so local worker-level activity concurrency limits must be explicit from day one.

## Goals / Non-Goals

**Goals:**
- Add Temporal SDK dependencies and a minimal runtime wiring for client and worker.
- Provide a local Docker Compose stack for Temporal server plus UI on predictable ports.
- Introduce a smoke workflow and activity proving end-to-end round-trip behavior.
- Encode and document activity-level concurrency limits tied to subscription fairness.
- Ensure the substrate is testable via root `npm test` without involving Linear or Claude SDK calls.

**Non-Goals:**
- Implement Linear polling, ticket workflows, or phase orchestration logic.
- Integrate live Claude Agent SDK calls.
- Add production deployment manifests or hosted Temporal infrastructure.
- Design advanced workflow retry policies beyond smoke coverage needs.

## Decisions

### 1) Keep Temporal wiring in a dedicated `server/src/temporal/` module tree
Create `client.ts`, `worker.ts`, `activities/hello.ts`, and `workflows/hello.ts` under a dedicated namespace. This isolates Temporal concerns from Express boot code and keeps future workflow growth structured.

**Alternatives considered:**
- Put worker/client code in `server/src/index.ts`: rejected because it couples HTTP lifecycle with worker lifecycle and makes tests harder.
- Scatter files by concern (activities next to app routes): rejected due to weak discoverability for orchestration code.

### 2) Configure one explicit task queue for substrate smoke runs
Use a single named task queue constant for worker and client smoke workflow start calls. This minimizes configuration surface while the system has one worker role.

**Alternatives considered:**
- Multiple queues now (spec/code/review): rejected as premature before `per-ticket-workflow` introduces phase activities.
- Dynamic task queue from workflow input: rejected to avoid avoidable misrouting in foundational phase.

### 3) Enforce Claude-facing activity concurrency in worker options
Set worker activity concurrency (`maxConcurrentActivityTaskExecutions`) to a conservative fixed value and document rationale inline. This gives hard backpressure in the exact component executing activities and aligns with shared-subscription constraints.

**Alternatives considered:**
- Rely only on workflow-level throttling: rejected because workflow scheduling alone does not prevent local activity overload.
- Delay limits until real Claude calls exist: rejected because starvation risk is an architectural constraint, not an integration detail.

### 4) Provide `docker-compose.yml` at repo root for local Temporal runtime
Add Temporal + UI services on ports `7233` and `8233` to support deterministic local development and integration tests.

**Alternatives considered:**
- Require developers to run external local Temporal tooling manually: rejected due to inconsistent onboarding and CI parity.
- Add Kubernetes manifests now: rejected as out of MVP scope.

### 5) Validate substrate through an end-to-end smoke test
Implement a `HelloWorkflow` and `hello` activity with deterministic output; add an integration test that starts workflow execution through the client and asserts completion output. This catches wiring regressions across client, worker registration, activity binding, and queue config.

**Alternatives considered:**
- Unit tests of each component in isolation only: rejected because they miss cross-component registration errors.
- Full per-ticket workflow now: rejected because it belongs to later roadmap changes.

## Risks / Trade-offs

- **[Risk] Local Temporal stack not running during test execution** -> Mitigation: keep smoke integration test clearly scoped and fail with actionable connection error; document compose startup in developer workflow.
- **[Risk] Concurrency limit set too low slows future throughput experiments** -> Mitigation: centralize constant and document how/why to tune once quota behavior is measured.
- **[Risk] Concurrency limit set too high causes subscription starvation later** -> Mitigation: start conservative, keep limit near Claude-facing activities, revisit after load signals in subsequent changes.
- **[Risk] Worker lifecycle assumptions diverge from eventual container-as-worker model** -> Mitigation: keep worker bootstrap minimal and side-effect free so it can be rehosted in container entrypoints.

## Migration Plan

1. Add Temporal dependencies to server package and lockfile.
2. Add Temporal module tree (`client`, `worker`, `activities`, `workflows`) and queue/config constants.
3. Add root `docker-compose.yml` with Temporal server and UI services.
4. Add smoke integration test that requires running local Temporal services.
5. Run `npm test` from repo root to confirm baseline and smoke behavior.

Rollback strategy: remove new Temporal modules and dependencies; existing Express/PGLite functionality remains unchanged because this change is additive.

## Open Questions

- Should the smoke integration test auto-skip when Temporal is unavailable, or should it remain hard-fail to enforce local stack discipline?
- What initial numeric concurrency cap best reflects current shared subscription limits for local/dev execution?
- Should worker startup live under an npm script in this change or be deferred until per-ticket workflow wiring lands?
