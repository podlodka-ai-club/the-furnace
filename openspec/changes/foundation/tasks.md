## 1. Install dependencies

- [x] 1.1 Run `npm install` at the repo root and confirm `node_modules/` resolves under `server/`.
- [x] 1.2 Confirm `npx tsc --noEmit -p server/tsconfig.json` exits `0` against the empty source tree before adding files.

## 2. App factory and middleware

- [x] 2.1 Create `server/src/app.ts` exporting `createApp(): Express` that instantiates Express, mounts `express.json()`, the request logger (from 2.2), the health route (from 3.1), and the error handler (from 2.3) in that order.
- [x] 2.2 Create `server/src/middleware/requestLogger.ts` exporting a middleware that captures `Date.now()` on entry and on `res.on("finish")` logs `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms` via `console.log`.
- [x] 2.3 Create `server/src/middleware/errorHandler.ts` exporting a 4-arg Express error handler that derives status from `err.status` (when integer in `400..599`, else `500`), responds JSON `{ error: { message, ...(NODE_ENV !== "production" ? { stack } : {}) } }`, and logs the error via `console.error`.
- [x] 2.4 Ensure `createApp()` is pure: calling it twice returns two independent Express instances with no shared mutable state.

## 3. Health route

- [x] 3.1 Create `server/src/routes/health.ts` exporting an Express `Router` that handles `GET /` by responding `200` with `{ status: "ok", uptimeMs: Math.floor(process.uptime() * 1000) }`. Mount it at `/health` in `app.ts`.
- [x] 3.2 Confirm the response `Content-Type` is `application/json` (Express default for `res.json`).

## 4. Server entry

- [x] 4.1 Create `server/src/index.ts` that imports `createApp`, calls `app.listen(Number(process.env.PORT) || 3000, callback)` where `callback` logs `Listening on port <PORT>`, and stores the returned `http.Server`.
- [x] 4.2 Register `process.on("SIGTERM", ...)` and `process.on("SIGINT", ...)` handlers that call `server.close(() => process.exit(0))`.
- [x] 4.3 Verify `npm run dev` from the repo root starts the watcher and `curl http://localhost:3000/health` returns the expected JSON.

## 5. Integration tests

- [x] 5.1 Create `server/tests/integration/health.test.ts` that imports `createApp`, wraps it with `supertest(app)`, and asserts `GET /health` returns `200`, `body.status === "ok"`, and `Number.isInteger(body.uptimeMs) && body.uptimeMs >= 0`.
- [x] 5.2 Add a test asserting that two `GET /health` calls separated by `await new Promise(r => setTimeout(r, 50))` produce strictly increasing `uptimeMs` values.
- [x] 5.3 Add a test asserting that the test does not bind any TCP port (Supertest uses an ephemeral handle and `createApp()` must not call `.listen`).

## 6. Error handler tests

- [x] 6.1 Create `server/tests/integration/errorHandler.test.ts` that mounts a throw-on-purpose route on a fresh `createApp()` instance via `app.get("/__test/throw", () => { throw new Error("boom"); })` BEFORE the error handler — note this requires either a test-only factory parameter or registering the throw route in the test against a Router merged into the app. Choose the simplest option that does not leak test routes into production.
- [x] 6.2 Assert that hitting the throwing route returns status `500`, `body.error.message === "boom"`, and `typeof body.error.stack === "string"` when `NODE_ENV` is unset.
- [x] 6.3 Assert that with `NODE_ENV=production`, `body.error.stack` is `undefined` while `body.error.message` is preserved. Restore `NODE_ENV` after the test.
- [x] 6.4 Assert that an error with `status: 418` produces a `418` response with the same body shape.

## 7. Request logger test

- [x] 7.1 In an integration test, spy on `console.log` (e.g., `vi.spyOn(console, "log")`), make a `GET /health` call, and assert exactly one call matching the regex `/^GET \/health 200 \d+ms$/`. Restore the spy.

## 8. Wiring and verification

- [x] 8.1 Run `npm test` at the repo root and confirm all tests pass with exit code `0`.
- [x] 8.2 Run `npx tsc --noEmit -p server/tsconfig.json` and confirm zero type errors.
- [x] 8.3 Run `npm run dev` and `curl -s http://localhost:3000/health | jq .` to verify shape end-to-end, then send `SIGTERM` and confirm the process exits `0` within 2 seconds.
- [x] 8.4 Stage only files added/modified by this change; confirm no stray edits to `server/package.json` (no new deps).

## 9. Changelog and commit

- [x] 9.1 Tick all task boxes above as work is completed.
- [x] 9.2 Commit with message `feat(foundation): runtime baseline server with /health` referencing this change.
