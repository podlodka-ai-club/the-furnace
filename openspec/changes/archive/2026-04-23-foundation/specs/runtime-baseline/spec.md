## ADDED Requirements

### Requirement: HTTP server boots from a single entry point

The system SHALL provide a `server/src/index.ts` entry point that, when executed, binds an HTTP server to the port specified by `process.env.PORT` (defaulting to `3000`) and serves the Express app constructed by `createApp()`.

#### Scenario: Server starts on the default port

- **WHEN** `npm run dev` is executed from the repository root with no `PORT` environment variable set
- **THEN** the process binds to TCP port `3000` and logs a single line containing `3000` to stdout within 5 seconds

#### Scenario: Server honors the PORT environment variable

- **WHEN** the entry point is executed with `PORT=4001` in the environment
- **THEN** the process binds to TCP port `4001` and does not bind to `3000`

#### Scenario: Server shuts down on SIGTERM

- **WHEN** the running server process receives `SIGTERM` or `SIGINT`
- **THEN** the process calls `server.close()`, waits for in-flight requests to finish, and exits with status code `0`

### Requirement: App factory produces a port-less Express instance

The system SHALL expose `createApp(): Express` from `server/src/app.ts`. The returned Express instance SHALL have all middleware and routes mounted but SHALL NOT call `.listen()` and SHALL NOT bind any network resource at construction time.

#### Scenario: App factory is callable without side effects

- **WHEN** `createApp()` is called from a test file with no `PORT` set
- **THEN** the call returns an Express instance and no TCP port is bound by the call

#### Scenario: App factory returns a fresh instance per call

- **WHEN** `createApp()` is called twice in succession
- **THEN** each call returns a distinct Express instance whose middleware stacks do not share mutable state

### Requirement: Health endpoint reports liveness and uptime

The system SHALL expose `GET /health` on the Express app. The endpoint SHALL respond with HTTP `200`, `Content-Type: application/json`, and a JSON body of the shape `{ "status": "ok", "uptimeMs": <integer> }` where `uptimeMs` is the integer number of milliseconds since the Node process started, computed at request time.

#### Scenario: Health endpoint returns ok and uptime

- **WHEN** a `GET /health` request is sent to the app via Supertest
- **THEN** the response status is `200`, `response.body.status` equals `"ok"`, and `response.body.uptimeMs` is a non-negative integer

#### Scenario: Uptime increases between successive calls

- **WHEN** two `GET /health` requests are sent at least 50 ms apart
- **THEN** the `uptimeMs` value of the second response is strictly greater than that of the first

#### Scenario: Health endpoint requires no dependencies

- **WHEN** the `/health` endpoint is invoked with no database, Temporal, or external service running
- **THEN** the endpoint still responds `200` with the expected body shape

### Requirement: All requests pass through a baseline request logger

The system SHALL register a request-logging middleware on the Express app that emits exactly one log line per completed request, in the format `<METHOD> <URL> <STATUS> <DURATION_MS>ms`, where `DURATION_MS` is an integer number of milliseconds measured from request receipt to response finish.

#### Scenario: Successful request is logged once

- **WHEN** a `GET /health` request completes successfully
- **THEN** exactly one log line matching the pattern `^GET /health 200 \d+ms$` is written to stdout

#### Scenario: Errored request is logged with error status

- **WHEN** a request is made to a route that throws synchronously and the error handler responds with status `500`
- **THEN** exactly one log line matching the pattern `^\w+ \S+ 500 \d+ms$` is written to stdout

### Requirement: All errors are returned as JSON via a single error handler

The system SHALL register a 4-arg Express error-handling middleware as the last middleware on the app. The handler SHALL respond with `Content-Type: application/json` and a body of shape `{ "error": { "message": <string> } }`. In non-production environments (`process.env.NODE_ENV !== "production"`), the body SHALL additionally include `error.stack` as a string. The HTTP status SHALL be `err.status` if it is an integer in the range `400..599`, otherwise `500`.

#### Scenario: Thrown error returns JSON 500 in development

- **WHEN** a route handler throws `new Error("boom")` and `NODE_ENV` is unset
- **THEN** the response status is `500`, `response.body.error.message` equals `"boom"`, and `response.body.error.stack` is a non-empty string

#### Scenario: Error stack is omitted in production

- **WHEN** a route handler throws and `NODE_ENV === "production"`
- **THEN** `response.body.error.stack` is `undefined` and `response.body.error.message` is still present

#### Scenario: Custom err.status is honored

- **WHEN** a route handler throws an error object with `status: 418`
- **THEN** the response status is `418` and the body still has shape `{ error: { message } }`

### Requirement: Project provides root-level dev and test scripts

The repository root `package.json` SHALL expose two scripts that are the sole supported entry points for local development and testing: `npm run dev` (starts the server with file-watch reload via `tsx watch`) and `npm test` (runs the Vitest suite once).

#### Scenario: npm run dev starts the watcher

- **WHEN** `npm run dev` is executed from the repository root
- **THEN** a `tsx watch`-based process starts and a `GET /health` request to the bound port returns `200` within 10 seconds

#### Scenario: npm test runs the Vitest suite

- **WHEN** `npm test` is executed from the repository root with no other arguments
- **THEN** Vitest discovers and runs every `*.test.ts` file under `server/tests/`, exits with code `0` when all pass, and exits non-zero on any failure
