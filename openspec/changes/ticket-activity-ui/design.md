## Context

The current app is an Express server (`server/src/index.ts` -> `createApp()`) with `/health` and pluggable routers. Workflow run state intentionally lives in Temporal after the DB layer was dropped, and `PerTicketWorkflow` already exposes `currentPhase`, `attemptCount`, and `currentRound` queries. The workflow history also records activity scheduling/completion/failure events, workflow input, workflow result, signals, and ApplicationFailure details for human-pause states.

The requested UI should be a local/operator interface, not a replacement orchestrator. It must make ticket progress readable while preserving the architectural constraint that Temporal is the source of truth.

## Goals / Non-Goals

**Goals:**

- Serve a React UI from the existing Express dev server path so `npm run dev` remains the local entry point.
- Provide read-only API endpoints that expose ticket workflow summaries and detailed activity timelines.
- Derive all status, attempts, review rounds, clarifications, and terminal outcomes from Temporal APIs and existing workflow queries/history.
- Make the UI useful for a single selected ticket: current status, phase path, attempts, review rounds, PR reference, and human-pause details.
- Keep the implementation testable by isolating Temporal normalization from Express and React rendering.

**Non-Goals:**

- No new database, cache, or persistence table.
- No Linear or GitHub API enrichment. Ticket and PR details are limited to values already present in Temporal workflow input, activity input/output, history, or workflow result.
- No mutating controls in this change: no cancel, retry, approve, tiebreak, merge, or clarification-answer actions.
- No changes to `PerTicketWorkflow` instrumentation or query handlers unless implementation discovers a type/export issue that blocks reading existing data.
- No replacement for Temporal Web. Deep links to Temporal Web are acceptable; this UI is the ticket-level operator view.

## Decisions

### 1. Express owns both API and frontend serving

Frontend code lives inside the existing server package:

- Source root: `server/ui/`.
- Vite config: `server/vite.config.ts`.
- Vite build output: `server/dist/ui/`.
- Frontend dependencies and test tooling: `server/package.json` and `server/package-lock.json`.

Add a UI route module and static/dev middleware to the existing Express app. In development, Express should mount Vite middleware with `root: server/ui` so the current server remains the entry point and the frontend gets fast reload. In production/test build mode, Express should serve the built React assets from `server/dist/ui/`.

The HTTP server entry point should not require Claude worker credentials just to listen. Move or remove the `assertWorkerAuthAvailable()` gate from `server/src/index.ts`; keep that validation in worker/container-launch paths (`server/src/temporal/worker.ts` and launch-time checks) where Claude auth is actually required. This lets `/health`, static UI serving, and read-only Temporal API routes run in UI-only local sessions.

Alternative considered: run Vite as a separate dev server and proxy API calls. Rejected because the request asks for the existing Express server as the backend and current dev-server experience; two local ports make operator setup and tests less direct.

### 2. Backend exposes normalized Temporal views, not raw histories

Add a small Temporal UI service layer, for example `server/src/temporal/ticket-activity.ts`, behind routes such as:

- `GET /api/ticket-workflows?status=all|running|closed&limit=50`
- `GET /api/ticket-workflows/:workflowId?runId=<runId>`

The service should use `createTemporalClient()` and the Temporal client/service APIs:

- `client.workflow.list({ query: 'WorkflowType="perTicketWorkflow"' })` for summaries when advanced visibility is available.
- If the typed visibility query fails because the local Temporal cluster only supports basic visibility, fall back to `client.workflow.list()` and client-side filter by workflow type/name. The fallback should over-fetch up to a conservative scan cap so it can return the requested `limit` without scanning the entire namespace indefinitely.
- `handle.describe()` or `workflowService.describeWorkflowExecution` for status, start/close time, history length, and execution identity.
- `handle.fetchHistory()` or `workflowService.getWorkflowExecutionHistory` for detail timelines.
- `handle.query("currentPhase")`, `handle.query("attemptCount")`, and `handle.query("currentRound")` as best-effort enrichment; query failures on closed/failed runs should not prevent history-backed rendering.
- Workflow completed-event decoding or `handle.result()` for PR/result detail on successful closed runs.
- `openPullRequestActivity` completion-event decoding for best-effort PR detail while a workflow is still running in review rounds. A running workflow can already have an open PR before its workflow result exists.

Temporal Web links should use the existing `TEMPORAL_WEB_BASE` config from `server/src/temporal/config.ts`, which currently defaults to the local Temporal UI at `http://localhost:8233`. If implementation changes that config to allow an empty/disabled value, the API should omit `temporalWebUrl` when no usable base URL is configured.

Alternative considered: expose raw Temporal event histories and normalize in React. Rejected because Temporal history payloads are verbose, event-type-specific, and harder to test in browser code. Normalizing server-side keeps the UI contract stable.

### 3. Timeline normalization is event-driven and lossy by design

The API should return a domain shape like:

```ts
interface TicketWorkflowSummary {
  workflowId: string;
  runId: string;
  ticketId?: string;
  ticketIdentifier?: string;
  title?: string;
  targetRepoSlug?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "terminated" | "timed_out" | "unknown";
  phase?: "queued" | "spec" | "coder" | "review" | "completed" | "cancelled";
  attemptCount?: number;
  currentRound?: number;
  startedAt?: string;
  closedAt?: string;
  pr?: { number: number; url: string };
  terminalFailure?: HumanPause | WorkflowFailure;
}

interface TicketWorkflowDetail extends TicketWorkflowSummary {
  timeline: TimelineEvent[];
  reviewRounds: ReviewRoundSummary[];
  humanPauses: HumanPause[];
  temporalWebUrl?: string;
}

interface HumanPause {
  type: "ac-clarification" | "dep-missing" | "design-question" | "review-round-cap";
  failureType:
    | "AcClarificationRequested"
    | "DepMissingRequested"
    | "DesignQuestionRequested"
    | "ReviewRoundCapExhausted";
  message?: string;
  subTicket?: { id?: string; identifier?: string; title?: string };
  review?: {
    verdict?: string;
    reasoning?: string;
    findingsCount?: number;
    prNumber?: number;
  };
}
```

Normalization should decode the workflow-start input to recover ticket identity and target repo slug, activity events to produce a chronological phase path, and failure chains to identify `AcClarificationRequested`, `DepMissingRequested`, `DesignQuestionRequested`, and `ReviewRoundCapExhausted`. Events that cannot be decoded safely should still appear with their Temporal event id, timestamp, and raw activity/workflow event type so the UI never pretends missing detail is known.

Alternative considered: add custom search attributes or a new workflow query that returns a prebuilt dashboard model. Rejected for this change because it would expand workflow behavior. Temporal history already contains enough data for a read-only first version.

### 4. Frontend is an operational dashboard, not a marketing page

The first screen should be the tool itself: a dense two-column view with a workflow list/filter column and a selected-ticket detail area. The selected view should include:

- A compact status header with ticket identifier/title, workflow id/run id, target repo, status, phase, attempt count, current round, elapsed/closed time, and PR link when present.
- A phase path/timeline that groups spec, coder, review, GitHub, Linear sync, launch-container, and cancellation events.
- A review attempts panel grouped by round, showing verdict/post-review outcomes when present.
- A human-pause panel for clarification, missing dependency, design question, and review-cap failures, including sub-ticket references when Temporal failure details contain them.
- Loading, empty, and Temporal-unavailable states that do not obscure existing data already rendered.

Use plain React state plus fetch calls for this first version. Avoid routing libraries and global state managers unless implementation shows the single-page state is becoming unclear.

Alternative considered: adopt a full component framework. Rejected because this repo has no frontend design system yet, and the UI is a compact internal tool where simple CSS is enough.

### 5. Freshness uses polling with manual refresh

The frontend should poll the selected detail endpoint while the selected workflow is running, and poll the list endpoint at a conservative interval. A refresh icon button gives the operator an immediate fetch. Closed workflows can stop detail polling unless manually refreshed.

Alternative considered: server-sent events or WebSockets. Rejected for the first version because Temporal remains the source of truth, operator latency is not sub-second critical, and polling keeps the Express server stateless.

### 6. Errors are explicit and typed at the API boundary

If Temporal is unavailable, API routes should return HTTP `503` with a JSON error. Missing workflow ids should return `404`. Bad query params should return `400`. These responses should use the existing JSON error handler shape where possible and must not leak stack traces in production.

No authentication is added in this change. The UI/API is a local operator surface intended for the current dev server, not an internet-facing dashboard. Deployments that expose it beyond a trusted local network must put auth in front of Express or add a separate auth change.

Alternative considered: return an empty dashboard when Temporal fails. Rejected because an empty list is ambiguous; operators need to distinguish "no workflows" from "Temporal cannot be reached."

## Risks / Trade-offs

- **Temporal visibility is eventually consistent** → show detail by workflow id/run id when selected and include a manual refresh control.
- **Basic Temporal visibility cannot filter server-side by workflow type** → fall back to bounded list-all scanning and client-side filtering; document the cap in code so large namespaces do not surprise operators.
- **History reads can be large on long review loops** → acceptable for V1 because review rounds are capped today, but keep normalization isolated so pagination/capping can be tightened later.
- **History decoding can lag new workflow activity names** → normalize unknown events generically and add unit tests for known Furnace activity names.
- **Workflow queries can fail on some terminal states** → treat query values as enrichment; fall back to history and describe data.
- **No Linear/GitHub enrichment means some labels or current PR state may be stale** → label those values as workflow-recorded values in code/types and avoid live-state claims in UI copy.
- **No built-in auth** → keep the feature local-only in docs and deployment assumptions until a dedicated auth proposal exists.
- **Frontend tooling adds new dependencies** → keep the dependency set narrow and covered by build/test scripts.
