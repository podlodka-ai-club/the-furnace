## Why

Operators currently need to piece together ticket progress from Temporal UI, Linear, GitHub, and logs. A focused web interface should make one ticket's current status, phase path, review rounds, attempts, and human clarification pauses visible from the running Furnace dev server without reintroducing an application database.

## What Changes

- Add a React/TypeScript frontend served by the existing Express server.
- Add Temporal-backed Express API routes that list ticket workflows and return a normalized per-ticket timeline.
- Show the current status of each ticket workflow, including phase, attempt count, review round, terminal result or failure, and PR reference when available.
- Show the activity path of a selected ticket from Temporal history, including spec, coder, review, PR-open, PR-review-post, cancellation, retry, and failure events.
- Highlight review attempts and human-pause failures such as AC clarifications, dependency-missing pauses, design-question pauses, and review-round cap exhaustion when those details are available in Temporal history.
- Keep the UI read-only for this change; no workflow signals, Linear mutations, retry controls, or manual override actions.
- Use only data available through Temporal APIs and existing workflow query handlers; do not add a database, cache, or Linear/GitHub reads for dashboard enrichment.

## Capabilities

### New Capabilities

- `ticket-activity-ui`: Read-only React and Express interface for inspecting Temporal-backed ticket workflow status, attempts, review rounds, activity path, clarifications, and terminal outcomes.

### Modified Capabilities

- None.

## Impact

- New frontend files under `server/ui/` with Express static/dev middleware integration and Vite output under `server/dist/ui/`.
- New backend route module under `server/src/routes/` plus Temporal timeline/normalization helpers.
- New npm dependencies for React frontend tooling, expected to include React, React DOM, Vite, the React Vite plugin, lucide-react for toolbar icons, and focused DOM test tooling.
- Root/server dev scripts may be adjusted so the existing `npm run dev` Express entry point can serve the UI during local development.
- Server startup should no longer require Claude worker auth merely to serve `/health`, the UI, or read-only Temporal API routes; worker auth checks remain on worker/container-launch paths.
- Temporal API usage is limited to workflow listing, description, history retrieval, workflow results, and existing query handlers (`currentPhase`, `attemptCount`, `currentRound`) where available.
- Tests cover Temporal-history normalization, API route behavior with stubbed Temporal clients, and core React rendering states.
