## 1. Temporal dependencies and configuration

- [x] 1.1 Add Temporal SDK dependencies (`@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`) in the server package.
- [x] 1.2 Add shared Temporal configuration constants for address, namespace, and smoke task queue with sensible local defaults.
- [x] 1.3 Define worker activity concurrency limit constant and inline documentation explaining Claude subscription fairness rationale.

## 2. Bootstrap Temporal runtime code

- [x] 2.1 Implement `server/src/temporal/client.ts` with a client factory that uses configurable endpoint and namespace.
- [x] 2.2 Implement `server/src/temporal/activities/hello.ts` with deterministic hello activity behavior for smoke coverage.
- [x] 2.3 Implement `server/src/temporal/workflows/hello.ts` with `HelloWorkflow` that invokes the hello activity and returns its result.
- [x] 2.4 Implement `server/src/temporal/worker.ts` that registers workflows/activities, applies concurrency limits, and runs against the configured task queue.

## 3. Local Temporal infrastructure

- [x] 3.1 Add root `docker-compose.yml` defining Temporal server and Temporal UI services.
- [x] 3.2 Ensure compose port mappings expose frontend on `7233` and UI on `8233` for local development.

## 4. Smoke validation and test wiring

- [x] 4.1 Add integration test coverage that starts the smoke workflow through the client and asserts successful round-trip output.
- [x] 4.2 Ensure the smoke test fails on worker/workflow/activity misconfiguration and gives actionable failure output.
- [x] 4.3 Run `npm test` from repo root and verify the full suite (including smoke coverage) passes with local Temporal services available.

## 5. Developer ergonomics

- [x] 5.1 Add minimal developer documentation for starting local Temporal services and running the smoke test.
- [x] 5.2 Reference and explain the activity-level concurrency setting near code/config where future changes will tune it.
