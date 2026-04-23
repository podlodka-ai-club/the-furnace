## Context

This is the first implementation change in `the-furnace`. The repo root already contains a scaffolded `server/` workspace (TypeScript ESM, Express + Vitest + Supertest + PGLite as transitive dependencies declared in `server/package.json`), but no source files yet exist under `server/src/` or `server/tests/`.

Every later change in the roadmap (`data-model`, `temporal-setup`, `linear-integration`, …) needs:

- A booted Node + TypeScript process to attach to.
- An app object that integration tests can drive without binding a real port.
- A health endpoint to prove the process is alive (used later as a Temporal worker liveness probe target and as a smoke test target in CI/devcontainers).
- A logging and error-handling baseline that downstream routes can rely on instead of re-inventing per-route.

Constraints from `CLAUDE.md` and `AGENTS.md`:

- Strict TypeScript, no `any` without justification, ESM only.
- Integration tests must hit real components (PGLite, real Express app via Supertest), not mocks.
- No new dependencies beyond those approved in this proposal — `server/package.json` already pins everything required (`express`, `cors`, `tsx`, `vitest`, `supertest`, `@electric-sql/pglite`). PGLite is a transitive concern of `data-model` and is intentionally not wired up here.
- `npm run dev` and `npm test` at the repo root already proxy into `server/` and must continue to work.

## Goals / Non-Goals

**Goals:**

- A `runtime-baseline` capability that boots an Express server on a configurable port (default `3000`) and exposes `GET /health` returning `{ status: "ok", uptimeMs: <integer> }`.
- Clean separation between the *app* (testable, port-less) and the *server entry* (binds the port, handles signals).
- A baseline request logger and a JSON error handler available to all future routes.
- An integration test for `/health` that drives the app via Supertest with no port binding and no mocking of Express.
- `npm run dev` (root) starts the server with file-watch reload via `tsx watch`.

**Non-Goals:**

- Wiring up PGLite, migrations, or any database access (owned by `data-model`).
- Adding Temporal client/worker bootstrap (owned by `temporal-setup`).
- Authentication, rate limiting, CORS policy beyond default-permissive (later changes will tighten).
- Production logging shape (structured JSON, log levels, correlation IDs) — a deliberate stub now, hardened later if a change proposes it.
- Containerization, Dockerfile, devcontainer.json (owned by `devcontainer-images`).
- Multi-package monorepo tooling (Turborepo / Nx). The root `npm run` proxy is sufficient until proven otherwise.

## Decisions

### D1. Split `app.ts` from `index.ts`

`src/app.ts` exports `createApp(): Express` — an Express instance with all middleware and routes mounted, but no `.listen()`. `src/index.ts` imports `createApp`, calls `.listen(PORT)`, and handles `SIGTERM`/`SIGINT` for graceful shutdown.

**Why:** Supertest binds the app to an ephemeral port per test, which is impossible if `index.ts` calls `.listen()` at import time. This split is the standard Express testability pattern and avoids the "test runs a real server on 3000 and collides with `npm run dev`" failure mode by construction.

**Alternative considered:** A single `index.ts` that only `.listen()`s when `import.meta.url === \`file://${process.argv[1]}\``. Rejected — it's a clever guard that breaks under bundlers, ts-node variants, and worker threads. The two-file split is boring and cannot misfire.

### D2. `/health` returns `{ status: "ok", uptimeMs }`

`uptimeMs` is computed as `Math.floor(process.uptime() * 1000)` at request time. No DB check, no dependency check — those belong to a future `/ready` endpoint owned by whichever change introduces the dependency.

**Why:** Liveness ≠ readiness. A liveness probe answers "is the process responsive?" — adding DB checks here would make the endpoint fail during PGLite init in `data-model`'s tests, breaking this change's own test transitively. Keep liveness pure; let later changes add `/ready` with their dependency-aware checks.

**Alternative considered:** `{ status, uptime, version, commit }`. Rejected for now — `version` and `commit` plumbing belongs to `provenance-store`. YAGNI.

### D3. Express 4, not Fastify or Hono

`server/package.json` already pins Express 4. Honoring that pin avoids re-litigating the framework choice in the foundation change. Migration to a different framework, if ever needed, would be its own proposal.

**Why:** The proposal is scoped to "stand up the skeleton," not "evaluate frameworks." The team has more Express experience; Supertest's Express integration is the most battle-tested.

### D4. Request logger as inline middleware, not Pino/Winston

A ~10-line middleware that logs `${method} ${url} ${status} ${ms}ms` to `console.log` at the end of each request. No log library, no transports, no levels.

**Why:** A real logger is a dependency choice that ripples through every later change. Defer it until a change actually needs structured logs (likely `temporal-setup` for activity correlation). Inline `console.log` is rip-out-and-replace cheap.

**Alternative considered:** Pino. Rejected — not approved in this proposal, and the proposal explicitly says "No external dependencies beyond those in `server/package.json`."

### D5. JSON error handler as the last `app.use`

A 4-arg Express error handler registered after all routes. It logs the error and responds `{ error: { message, ...(NODE_ENV !== "production" && { stack }) } }` with status 500 (or `err.status` if set).

**Why:** Without an error handler, Express's default HTML error page leaks stack traces in dev and is unfriendly to API consumers. A single handler is the natural place to enforce the JSON-everywhere contract that all later API routes will rely on.

### D6. Port and env via `process.env`, no config library

`PORT` defaults to `3000`. Read directly from `process.env.PORT` in `index.ts`.

**Why:** One env var doesn't justify a config library. When `temporal-setup` adds Temporal address/namespace and `linear-integration` adds API keys, that change can introduce a config module if the surface area warrants it.

### D7. Vitest config: zero-config, conventions only

No `vitest.config.ts`. Vitest discovers `**/*.test.ts` under `tests/` by default. Integration tests live in `server/tests/integration/` per the proposal.

**Why:** Adding config now invites premature decisions (coverage thresholds, reporters, setup files). A `vitest.config.ts` can be added by the first change that actually needs config.

## Risks / Trade-offs

- **Risk:** Inline `console.log` request logger gets entrenched and we never adopt structured logging. → **Mitigation:** The middleware lives in one file (`src/middleware/requestLogger.ts`) and is one swap away from being replaced. `temporal-setup` proposal must explicitly take a position on logging.
- **Risk:** No `/ready` endpoint means orchestrators that need a readiness signal will block on this. → **Mitigation:** `/health` is sufficient for liveness; `/ready` is added by the first change that introduces a dependency that warrants it (likely `data-model` or `temporal-setup`).
- **Risk:** Splitting `app.ts` and `index.ts` is overkill for a one-route server. → **Accepted.** The split costs ~5 lines and unlocks Supertest integration tests, which is the testing pattern mandated by the project's conventions for every later change.
- **Risk:** No graceful shutdown drain (in-flight request handling on SIGTERM). → **Accepted for now.** `index.ts` calls `server.close()` on SIGTERM/SIGINT — Node's default `server.close` waits for in-flight requests. No long-running streams exist yet to warrant more.
- **Trade-off:** No CI workflow file in this change. → **Accepted.** CI is its own concern; the proposal scope is local-runnable skeleton. A later change can add `.github/workflows/test.yml` once there's enough surface area to test in CI.
