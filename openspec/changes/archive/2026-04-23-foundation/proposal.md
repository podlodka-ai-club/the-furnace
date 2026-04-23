## Why

Every downstream change (Temporal, agents, integrations) needs a runnable Node + TypeScript skeleton to build on. Without a minimum server that boots and exposes a health endpoint, later changes have nowhere to land.

## What Changes

- Establish root + `server/` package layout with TypeScript and ESM.
- Add `tsx watch`-based dev runner and Vitest as the test runner.
- Add `/health` endpoint returning `{ status: "ok", uptimeMs: <n> }`.
- Add a minimal Express app factory (`app.ts`) separated from the server entry (`index.ts`) so integration tests can hit the app without binding a port.
- Add a baseline request logger and a JSON error handler.

## Capabilities

### New Capabilities

- `runtime-baseline`: Boots the Node/Express server with health endpoint, structured logging, and a testable app factory.

### Modified Capabilities

(none — first change)

## Impact

- New: `server/src/index.ts`, `server/src/app.ts`, `server/src/routes/health.ts`, `server/tests/integration/health.test.ts`.
- Scripts: `npm run dev` starts the server on port 3000.
- No external dependencies beyond those in `server/package.json`.
