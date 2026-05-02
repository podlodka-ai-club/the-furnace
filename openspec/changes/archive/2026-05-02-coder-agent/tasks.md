## 1. Shared Substrate Refactor

- [x] 1.1 Move `server/src/agents/spec/repo-ops.ts` to `server/src/agents/shared/repo-ops.ts` and update the import in `server/src/agents/spec/activity.ts` (and any other callers)
- [x] 1.2 Add `checkoutFeatureBranch(ctx, branch)` to shared repo-ops: runs `git fetch origin <branch>`, checks it out, asserts the working tree is clean
- [x] 1.3 Add `diffPathsTouched(ctx, basisRef, paths)` to shared repo-ops: returns the subset of `paths` modified between `basisRef` and `HEAD` (uses `git diff --name-only`)
- [x] 1.4 Add `commitAll(ctx, subject, trailer)` to shared repo-ops: stages all working-tree changes and creates a single commit with the structured trailer
- [x] 1.5 Extract a parameterized `AgentSessionConfig<TDecision>` base from `server/src/agents/spec/sdk-client.ts` into `server/src/agents/shared/sdk-session.ts` (shared pump loop, deliver mechanic, input-stream plumbing, CLI-spawn diagnostics, end-of-turn handling)
- [x] 1.6 Refactor `SdkSpecAgentClient` to compose the shared base, preserving its current public surface and behavior
- [x] 1.7 Run the existing spec activity tests and confirm all stay green after the refactor

## 2. Coder Prompt and Config

- [x] 2.1 Create `server/src/agents/coder/prompt.md` with placeholders `{{TICKET_IDENTIFIER}}`, `{{TICKET_TITLE}}`, `{{TICKET_DESCRIPTION}}`, `{{WORKER_REPO_PATH}}`, `{{FEATURE_BRANCH}}`, `{{TEST_FILES}}`
- [x] 2.2 Include in the prompt: descriptions of the three terminal tools, the prohibition on modifying spec test files, the anti-shortcut clause for stuck tools, and the statement that the activity (not the agent) verifies tests
- [x] 2.3 Add `CODER_CORRECTION_BUDGET` env var to `server/src/config.ts` (default `3`, parseable as positive integer) and surface it via the existing config object
- [x] 2.4 Confirm `WORKER_REPO_PATH` (default `/workspace`) and `TEMPORAL_WEB_BASE` are already exported from `config.ts`; if not, add them

## 3. Coder Tools and Decision Schema

- [x] 3.1 Create `server/src/agents/coder/tools.ts` defining strict JSON schemas for `submit_implementation({ summary })`, `report_dep_missing({ reason, dependency, questions })`, and `report_design_question({ reason, questions })`
- [x] 3.2 Define a discriminated `CoderDecision` type covering the three terminal outcomes plus a `malformed_tool_call` variant for the SDK pump to deliver on bad arg shapes
- [x] 3.3 Create `server/src/agents/coder/agent.ts` mirroring `agents/spec/agent.ts`'s session/decision typing and exporting the tool definitions consumable by the shared SDK session

## 4. Coder SDK Client

- [x] 4.1 Create `server/src/agents/coder/sdk-client.ts` that composes `agents/shared/sdk-session.ts` with the coder's three terminal tools and the built-in tool set `Read | Glob | Grep | Bash | Edit | Write`
- [x] 4.2 Confirm via the typing surface that the client's decision type is `CoderDecision`, distinct from the spec's

## 5. Coder Activity

- [x] 5.1 Create `server/src/agents/coder/activity.ts` exporting `runCoderPhase` whose entry parses input via `coderPhaseInputSchema.parse` (throw `ApplicationFailure.nonRetryable` of type `InvalidCoderPhaseInput` on failure)
- [x] 5.2 Define `coderPhaseInputSchema` as `{ ticket: ReviewerTicket, specOutput: SpecPhaseOutput }` (re-using the existing `reviewerTicketSchema` and `specPhaseOutputSchema`)
- [x] 5.3 Read `server/src/agents/coder/prompt.md` via `fs.readFile` at activity entry and interpolate placeholders (ticket fields, `WORKER_REPO_PATH`, feature branch, test paths bullet list)
- [x] 5.4 Resolve `WORKER_REPO_PATH` from env (default `/workspace`); call `checkoutFeatureBranch` for `specOutput.featureBranch`; capture the post-checkout HEAD SHA as the `preAgentSha` basis for the diff check
- [x] 5.5 Implement heartbeat: `Context.heartbeat()` at start, `setInterval` every 5s while the SDK runs, heartbeat immediately before each test run / git op / push, clear interval in a `finally` block
- [x] 5.6 Drive the SDK conversation until it returns a terminal `CoderDecision`; on prose-only or `malformed_tool_call` send a corrective message; cap total corrections at `CODER_CORRECTION_BUDGET`; throw retryable on exhaustion

## 6. submit_implementation Branch

- [x] 6.1 On `submit_implementation`, call `diffPathsTouched(ctx, preAgentSha, specOutput.testCommits.map(c => c.path))`; if any test path comes back, send a corrective message naming the modified paths and request another iteration (sharing the correction budget)
- [x] 6.2 Resolve and run the repo's test command via `resolveTestCommand`; if exit code is non-zero, send a corrective message including the runner output tail and request another iteration (sharing the correction budget)
- [x] 6.3 On verified pass and clean test-file diff, call `commitAll` with subject `feat(coder): make spec tests green for <ticket-identifier>` and trailer including `Workflow-Id`, `Ticket-Id`, `Attempt`, `Phase: coder`
- [x] 6.4 Push the feature branch with `git push origin <featureBranch>`; throw a retryable error on push failure
- [x] 6.5 Build a value satisfying `coderPhaseOutputSchema` (feature branch, final commit SHA, diff stat from `git diff --shortstat <preAgentSha> HEAD`, parsed test run summary) and validate via `.parse(output)` before returning

## 7. report_dep_missing and report_design_question Branches

- [x] 7.1 Add a shared `buildStuckBody({ reason, dependency?, questions })` helper that formats the body as Markdown (reason paragraph, optional dependency line, questions checklist)
- [x] 7.2 On `report_dep_missing`, build the workflow deep link from `TEMPORAL_WEB_BASE` plus `Context.current().info`; call `linearClient.createSubTicket(input.ticket.id, "dep-missing", body, deepLink)`; rethrow as retryable on Linear outage
- [x] 7.3 On success, throw `ApplicationFailure.nonRetryable("coder.dep_missing_requested", "DepMissingRequested", { subTicketRef: { id, identifier, title } })`
- [x] 7.4 On `report_design_question`, mirror 7.2 with sub-ticket type `design-question`
- [x] 7.5 On success, throw `ApplicationFailure.nonRetryable("coder.design_question_requested", "DesignQuestionRequested", { subTicketRef })`

## 8. Wiring and Activity Registry

- [x] 8.1 Update `server/src/temporal/activities/phases.ts` so `runCoderPhase` re-exports from `agents/coder/activity.ts` (preserving the existing import shape used by the worker registry and the workflow)
- [x] 8.2 Verify the per-repo container worker registers the new `runCoderPhase` (no orchestrator-side registration for the SDK call)
- [x] 8.3 Confirm the coder proxy in the workflow keeps `heartbeatTimeout: 30s` and `startToCloseTimeout: 10 minutes`; do not change other phase activity options

## 9. Workflow Integration

- [x] 9.1 Update `perTicketWorkflow` to call `runCoderPhase({ ticket: input.ticket, specOutput })` instead of `runCoderPhase(specOutput)`
- [x] 9.2 Wrap the coder phase in `try`/`catch`: catch `DepMissingRequested` (matched by `failure.type` on `ApplicationFailure`) before generic catches, record the sub-ticket reference in the workflow's failure detail, do not invoke `runReviewPhase`, leave the Linear ticket in `In Progress`
- [x] 9.3 Catch `DesignQuestionRequested` analogously to 9.2 (different failure type, same handling shape)
- [x] 9.4 Re-throw all other failures so Temporal surfaces normal retry/failure semantics
- [x] 9.5 Confirm the existing `cancel` signal handler still aborts before the coder phase when cancelled between spec and coder, and stops before the review phase when cancelled mid-coder

## 10. Tests

- [x] 10.1 Add unit tests for the coder activity using a stubbed SDK client: successful `submit_implementation` path (tests pass on first verification, no test files touched, commit + push succeed)
- [x] 10.2 Add unit test: false-pass correction loop (agent submits, activity verifies tests still fail, corrective message sent, second submission passes)
- [x] 10.3 Add unit test: test-file-modification correction loop (agent submits with a spec test file modified, corrective message names the path, second submission has clean test paths)
- [x] 10.4 Add unit test: prose-only correction loop with budget exhaustion (agent never calls a terminal tool; retryable error fires after 3 corrections)
- [x] 10.5 Add unit test: `report_dep_missing` happy path (Linear sub-ticket created with formatted body and deep link, non-retryable failure with `DepMissingRequested` type and sub-ticket detail)
- [x] 10.6 Add unit test: `report_design_question` happy path (analogous to 10.5 with `design-question` type)
- [x] 10.7 Add unit test: Linear outage during `createSubTicket` produces a retryable error
- [x] 10.8 Add unit test: invalid input throws non-retryable `InvalidCoderPhaseInput`; invalid output (forced via stubbed return) throws before reaching the workflow
- [x] 10.9 Add unit tests for the new shared repo-ops helpers (`checkoutFeatureBranch`, `diffPathsTouched`, `commitAll`) using a temp git repo fixture
- [x] 10.10 Add a workflow test: stubbed coder activity throws `DepMissingRequested` → assert review phase NOT invoked, workflow failure detail contains the sub-ticket ref, ticket NOT cancelled
- [x] 10.11 Add a workflow test: stubbed coder activity throws `DesignQuestionRequested` → analogous assertions to 10.10
- [x] 10.12 Add a workflow test: stubbed coder activity returns valid `CoderPhaseOutput` → review phase invoked with the coder output
- [x] 10.13 Add a workflow test: stubbed coder activity throws a generic non-stuck failure → workflow surfaces it via normal failure semantics
- [x] 10.14 Run the existing per-ticket workflow integration test with the SDK and tools mocked to verify end-to-end shape passes through
- [x] 10.15 Verify `TEMPORAL_TASK_QUEUE=local-test npm test` (the standard full verification per TESTING.md) and `npm run build:worker` pass with no new errors
