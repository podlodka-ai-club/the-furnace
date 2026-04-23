## Why

Per concept §3.1, Temporal is load-bearing: durable state, signals, queryable in-flight state, and — under the subscription-auth constraint — activity-level rate limiting that prevents concurrent Claude SDK calls from starving a single subscription. This substrate must exist before any workflow or agent code is written.

## What Changes

- Add `@temporalio/client` and `@temporalio/worker` dependencies.
- Add a worker entry point (`server/src/temporal/worker.ts`) that registers activities and workflows and connects to the Temporal server.
- Add a task queue configuration with per-activity concurrency limits calibrated for the shared Claude subscription.
- Add a local `docker-compose.yml` bringing up Temporal server + web UI for local dev.
- Add a smoke workflow (`HelloWorkflow`) exercising client → worker → activity round-trip; used in CI to verify the substrate without agent logic.
- Document the subscription-quota reasoning inline in the rate-limit config.

## Capabilities

### New Capabilities

- `orchestration-substrate`: Temporal worker/client bootstrap, per-activity rate limits, local dev compose stack, and a smoke workflow for substrate validation.

### Modified Capabilities

(none)

## Impact

- New deps: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`.
- New files: `server/src/temporal/worker.ts`, `server/src/temporal/client.ts`, `server/src/temporal/activities/hello.ts`, `server/src/temporal/workflows/hello.ts`, `docker-compose.yml`.
- Ports: Temporal 7233 (frontend), Temporal UI 8233.
- Does not yet consume Linear or Claude SDK — those come in later changes.
