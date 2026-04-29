## 1. Dependencies and Prompt

- [x] 1.1 Add `@anthropic-ai/claude-agent-sdk` to `server/package.json` dependencies and run `npm install`
- [x] 1.2 Verify the SDK gets included in the worker bundle output (`npm run build:worker`) so it is available inside containers
- [x] 1.3 Create `server/src/agents/spec/prompt.md` with: ticket title/description placeholders, descriptions of `propose_failing_tests` and `request_ac_clarification` tools, constraints (tests must fail on default branch, must use existing repo test framework, must not modify production code), anti-shortcut clause, and reference to `WORKER_REPO_PATH`
- [x] 1.4 Add `TEMPORAL_WEB_BASE` env var (default `http://localhost:8233`) to `server/src/config.ts` and document it
- [x] 1.5 Add `WORKER_REPO_PATH` env var handling (default `/workspace`) read by the spec activity at runtime

## 2. Spec Activity Implementation

- [x] 2.1 Create `server/src/agents/spec/activity.ts` exporting `runSpecPhase` whose entry parses input via `specPhaseInputSchema.parse` (throw `ApplicationFailure.nonRetryable` of type `InvalidSpecPhaseInput` on failure)
- [x] 2.2 Fetch the ticket row (title + description) from the `tickets` table at activity entry, keyed by `input.ticket.id`
- [x] 2.3 Read `server/src/agents/spec/prompt.md` via `fs.readFile` at activity entry (not module import) and interpolate ticket fields and `WORKER_REPO_PATH`
- [x] 2.4 Define the two custom tools (`propose_failing_tests`, `request_ac_clarification`) with strict JSON schemas the SDK enforces
- [x] 2.5 Instantiate the Claude Agent SDK conversation with the prompt, the two custom tools, and read-only filesystem/exploratory shell tools rooted at `WORKER_REPO_PATH`
- [x] 2.6 Implement the conversation loop: drive the SDK until it calls one of the two tools, sending corrective messages on prose-only or malformed-tool-args responses, capped at 3 corrections per conversation; throw a retryable error when the budget is exhausted
- [x] 2.7 Implement heartbeat: call `Context.heartbeat()` at activity start, set a 5-second `setInterval` while the SDK runs, heartbeat immediately before each test run / git push, and clear the interval in a `finally` block

## 3. propose_failing_tests Branch

- [x] 3.1 On `propose_failing_tests`, write each proposed file under `WORKER_REPO_PATH` using its provided `path` and `contents`
- [x] 3.2 Resolve the test command from the repo's `package.json` `scripts.test` field, falling back to `npm test`
- [x] 3.3 Run the test command and confirm at least one of the new test files fails; if any new test passes, send a corrective message naming which tests passed and request replacements (sharing the correction budget from 2.6)
- [x] 3.4 Create feature branch `agent/spec-<ticket-identifier-lowercased>` from the repo's default branch (only after verification succeeds)
- [x] 3.5 Commit each proposed test file as its own commit with message `test(spec): failing test for <description>` and a structured trailer including `Workflow-Id`, `Ticket-Id`, `Attempt`, `Phase: spec`
- [x] 3.6 Push the feature branch with `git push --set-upstream origin <branch>`; throw a retryable error if the push fails
- [x] 3.7 Build and return a value satisfying `specPhaseOutputSchema` (feature branch + per-file commit SHAs); validate via `.parse(output)` before returning so a malformed payload throws rather than reaches the workflow

## 4. request_ac_clarification Branch

- [x] 4.1 On `request_ac_clarification`, format the agent-supplied `questions` as a Markdown checklist body
- [x] 4.2 Build a workflow deep link from `TEMPORAL_WEB_BASE` plus the current namespace and workflow id available via `Context.current().info`
- [x] 4.3 Call `linearClient.createSubTicket(input.ticket.id, "ac-clarification", body, workflowDeepLink)`; if the call throws (Linear outage), rethrow as a retryable error so Temporal retries the activity
- [x] 4.4 Throw `ApplicationFailure.nonRetryable("spec.ac_clarification_requested", "AcClarificationRequested", { subTicketRef: { id, identifier, title } })` on success

## 5. Wiring and Activity Registry

- [x] 5.1 Update `server/src/temporal/activities/phases.ts` so `runSpecPhase` re-exports from `agents/spec/activity.ts` (preserving the existing import shape used by the worker registry and the workflow)
- [x] 5.2 Verify the per-repo container worker registers the new `runSpecPhase` (no orchestrator-side registration for the SDK call)
- [x] 5.3 Confirm `heartbeatTimeout: 30s` is preserved on the `runSpecPhase` proxy in the workflow; do not change other phase activity options

## 6. recordAttempt Activity

- [x] 6.1 Create `server/src/temporal/activities/attempts.ts` exporting `recordAttempt({ workflowId, phase, attemptIndex, outcome })` that inserts a row into the `attempts` table on the orchestrator's PGLite/Postgres
- [x] 6.2 Register `recordAttempt` on the orchestrator-side worker only (not the per-repo container worker — PGLite is in-process to the orchestrator)
- [x] 6.3 Add a unit test for `recordAttempt` covering the four outcome values (`pending`, `passed`, `failed`, `stuck`)

## 7. Workflow Integration

- [x] 7.1 Update `perTicketWorkflow` (`server/src/temporal/workflows/per-ticket.ts`) to wrap the spec phase in `try`/`catch`/`finally`: success path records `recordAttempt({ outcome: 'passed' })` then proceeds to coder
- [x] 7.2 Catch `AcClarificationRequested` (matched by `failure.type` on `ApplicationFailure`) before generic catches: record `recordAttempt({ outcome: 'stuck' })`, persist `workflow_runs.status = 'failed'` with structured failure detail containing `subTicketRef`, and return without invoking `runCoderPhase`
- [x] 7.3 Catch all other failures from the spec phase: record `recordAttempt({ outcome: 'failed' })` and re-throw so Temporal surfaces normal failure semantics
- [x] 7.4 Verify the existing `cancel` signal handler still aborts before the coder phase if the workflow is cancelled mid-spec

## 8. Tests

- [x] 8.1 Add unit tests for the spec activity using a stubbed SDK client (no network) covering: successful `propose_failing_tests` path, false-failing-test correction loop, prose-only correction loop with budget exhaustion, `request_ac_clarification` happy path, Linear outage retryable error path
- [x] 8.2 Add a workflow test for the clarification path: stubbed spec activity throws `AcClarificationRequested` → assert `recordAttempt` called with `outcome: 'stuck'`, `workflow_runs.status = 'failed'` with structured detail, coder phase NOT invoked, ticket NOT cancelled
- [x] 8.3 Add a workflow test for the success path: stubbed spec activity returns valid `SpecPhaseOutput` → assert `recordAttempt` called with `outcome: 'passed'` and coder phase invoked
- [x] 8.4 Add a workflow test for generic failure: stubbed spec activity throws non-clarification failure → assert `recordAttempt` called with `outcome: 'failed'` and the failure surfaces
- [x] 8.5 Run the existing `temporal.ticketWorkflows.test.ts` integration test with the SDK and tools mocked to verify the no-op output shape still passes through end-to-end
- [x] 8.6 Verify `npm test` and `npm run typecheck` (or equivalent) pass with no new errors
