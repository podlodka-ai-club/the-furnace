## 1. Frontend Tooling And Server Integration

- [x] 1.1 Add React, React DOM, Vite, React Vite plugin, lucide-react, and focused DOM test dependencies to `server/package.json` and update `server/package-lock.json`
- [x] 1.2 Add frontend source structure under `server/ui/` with TypeScript config, `server/vite.config.ts`, HTML shell, React entry point, and app-level CSS
- [x] 1.3 Configure Vite with `root: server/ui` and production build output at `server/dist/ui/`
- [x] 1.4 Update the existing Express app to serve built frontend assets from `server/dist/ui/` in production/test asset mode
- [x] 1.5 Add development-mode Vite middleware or equivalent integration so the existing `npm run dev` server can serve the React UI
- [x] 1.6 Remove HTTP startup's dependency on `assertWorkerAuthAvailable()` while preserving worker/container-launch auth validation
- [x] 1.7 Ensure `/health` and existing Express middleware behavior remain unchanged after UI serving is added

## 2. Temporal Activity Data Model

- [x] 2.1 Define strict TypeScript types for workflow summaries, workflow details, timeline events, review-round summaries, human-pause items, and API errors
- [x] 2.2 Add a Temporal ticket-activity service module that lists `perTicketWorkflow` executions through Temporal visibility APIs
- [x] 2.3 Implement fallback listing for basic-visibility Temporal clusters by bounded list-all scanning and client-side workflow-type filtering
- [x] 2.4 Add workflow describe/query helpers that read status, phase, attempt count, current round, run identity, timestamps, and result data without throwing away workflows when queries fail
- [x] 2.5 Add history decoding helpers for workflow-start input, workflow result, activity inputs/outputs, failure chains, and cancellation/signal events
- [x] 2.6 Decode completed `openPullRequestActivity` history events so running workflows in review can expose workflow-recorded PR references before workflow result exists
- [x] 2.7 Implement timeline normalization for known Furnace activity types and generic fallback entries for unknown Temporal events
- [x] 2.8 Implement human-pause extraction for `AcClarificationRequested`, `DepMissingRequested`, `DesignQuestionRequested`, and `ReviewRoundCapExhausted`
- [x] 2.9 Implement review-round grouping from `runReviewPhase` events and related PR review post events
- [x] 2.10 Add Temporal Web deep-link construction using `TEMPORAL_WEB_BASE`, omitting the link if no usable base URL is configured

## 3. Express API Routes

- [x] 3.1 Add `GET /api/ticket-workflows` route with validation for status filter and limit parameters
- [x] 3.2 Add `GET /api/ticket-workflows/:workflowId` route with optional run id validation
- [x] 3.3 Map Temporal unavailable failures to HTTP `503`, missing workflow executions to `404`, and invalid parameters to `400`
- [x] 3.4 Mount the ticket activity API router from `createApp()` without requiring a database, Linear client, or GitHub client
- [x] 3.5 Keep API responses JSON-serializable and stable for the React client

## 4. React Application

- [x] 4.1 Build the workflow list/filter panel backed by `GET /api/ticket-workflows`
- [x] 4.2 Build selected workflow data fetching backed by `GET /api/ticket-workflows/:workflowId`
- [x] 4.3 Render compact selected-workflow status including ticket identity, workflow/run ids, target repo, status, phase, attempts, current round, timestamps, PR link, and Temporal Web link when present
- [x] 4.4 Render chronological activity timeline with distinct visual states for pending/running/completed/failed/cancelled/unknown events
- [x] 4.5 Render review attempts grouped by round with verdict, reasoning, findings count, and PR post state when available
- [x] 4.6 Render human-pause items prominently, including sub-ticket references when available
- [x] 4.7 Add loading, empty, error, Temporal-unavailable, manual refresh, and running-workflow polling states
- [x] 4.8 Confirm the UI exposes no mutating controls or calls to mutating endpoints

## 5. Tests

- [x] 5.1 Add unit tests for workflow-summary normalization from Temporal list/describe/query stubs
- [x] 5.2 Add unit tests for basic-visibility fallback listing and scan-cap behavior
- [x] 5.3 Add unit tests for timeline normalization of spec, coder, review, worker launch, Linear sync, GitHub PR/review, cancellation, failure, and unknown events
- [x] 5.4 Add unit tests that decode PR references from completed `openPullRequestActivity` history before workflow completion
- [x] 5.5 Add unit tests for human-pause and review-round extraction from representative Temporal failure/history fixtures
- [x] 5.6 Add Supertest coverage for workflow list/detail API success cases with stubbed Temporal service clients
- [x] 5.7 Add Supertest coverage for invalid parameters, Temporal unavailable, and missing workflow responses
- [x] 5.8 Add Supertest coverage that HTTP startup/UI routes do not require Claude worker auth
- [x] 5.9 Add React rendering tests for summary list, selected status, timeline, review attempts, human pauses, and error/loading/empty states
- [x] 5.10 Add regression test coverage that `/health` remains unchanged after UI and API routes are mounted

## 6. Verification

- [x] 6.1 Run frontend build/typecheck or the equivalent project build script added by this change
- [x] 6.2 Run `npm run --prefix server test` for focused server/API/frontend unit coverage
- [x] 6.3 Run `TEMPORAL_TASK_QUEUE=local-test npm test` from the repo root after Temporal is running
- [x] 6.4 Run `openspec validate ticket-activity-ui --strict`
