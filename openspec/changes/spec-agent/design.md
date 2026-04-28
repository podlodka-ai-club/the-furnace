## Context

The per-ticket workflow (`server/src/temporal/workflows/per-ticket.ts`) currently dispatches three phase activities — `runSpecPhase`, `runCoderPhase`, `runReviewPhase` — that live as no-op stubs in `server/src/temporal/activities/phases.ts`. Each no-op returns a placeholder `SpecPhaseOutput` (feature-branch name + a fake commit SHA) and the contracts defined in `server/src/agents/contracts/spec-output.ts` already enforce the shape we want for the real output.

The container-worker substrate is in place: `runSpecPhase` runs inside an ephemeral devcontainer that has been launched by `launchWorkerContainer`, with `~/.claude` bind-mounted read-only and the worker bundle at `/opt/furnace`. The repo is already cloned and dependencies installed (per the pre-warmed image).

Linear integration also exists: `createLinearClient` exposes `createSubTicket(parentId, type, body, workflowDeepLink)` with `type` constrained to `ac-clarification | dep-missing | design-question`, and the `attempts` table in `data-persistence` already accepts an `outcome` column with values `pending | passed | failed | stuck`.

What is missing is a real spec-phase body that:
1. Reads ticket details from the `tickets` row (we already have `ticket.id` flowing through workflow input, but the agent prompt needs the ticket's title + description, fetched at activity entry).
2. Invokes the Claude Agent SDK with a spec-focused system prompt.
3. Allows the agent to operate on the in-container working tree (cloned repo) and produce one commit per failing test file on a feature branch.
4. Detects "ambiguous AC" as a structured outcome — not by string parsing, but as a deliberate tool call the agent can make instead of writing tests.
5. Writes an `attempts` row recording the outcome before the activity returns, regardless of branch taken.

The change is constrained by:
- Subscription auth (one shared Claude key, mounted via `~/.claude`). The activity must not consume more concurrency than necessary; the orchestrator's `CLAUDE_ACTIVITY_CONCURRENCY` rate-limits parallel activities.
- Determinism: the activity body runs inside a Temporal activity (not a workflow), so ad-hoc network calls and file IO are fine. But it must heartbeat (`Context.heartbeat()`) on a cadence inside `heartbeatTimeout: 30s` for cooperative cancellation.
- The container is per-attempt: each invocation starts from a clean repo clone. State that needs to survive is committed to git (the feature branch is pushed to origin).
- `ApplicationFailure.nonRetryable` is already in use for invalid input. The "stuck on ambiguous AC" path must surface as non-retryable so Temporal does not loop the same prompt.

Stakeholders: spec-agent change owner (this proposal), coder-agent change (downstream consumer of `SpecPhaseOutput`), provenance-store change (will eventually hash tool calls — not in scope here, but the activity must not preclude later instrumentation).

## Goals / Non-Goals

**Goals:**
- Replace `runSpecPhase` no-op with a real activity that drives the Claude Agent SDK to produce failing tests on a feature branch, OR opens an `ac-clarification` sub-ticket and fails non-retryable.
- Make the agent's "I cannot write tests because AC is ambiguous" path a structured tool decision, not free-form text the activity has to parse.
- Persist one `attempts` row per invocation with an outcome of `tests-written` or `clarification-requested` (mapped to the schema's `passed` / `stuck` outcome enum — see Decisions).
- Keep the activity boundary contract-validated: input parses against `specPhaseInputSchema`, output parses against `specPhaseOutputSchema`.
- Add `@anthropic-ai/claude-agent-sdk` as a dependency on the orchestrator side (also bundled into the worker bundle so it's available inside containers).
- Heartbeat on a schedule the existing `heartbeatTimeout: 30s` accommodates; honor cooperative cancellation.

**Non-Goals:**
- Running the coder-agent loop (separate change, depends on this output).
- Writing or using a provenance store. We log decisions in stdout for now; structured provenance is a later change.
- Any persona-reviewer logic.
- Multi-language test scaffolding heuristics. The agent decides what test framework to use based on what the in-container repo already declares; we do not encode language-specific knowledge in this change.
- Chat history persistence beyond the single activity invocation. Each attempt is one fresh SDK conversation.

## Decisions

### 1. Two-tool agent surface: `propose_failing_tests` vs `request_ac_clarification`

The Claude Agent SDK is given exactly two custom tools (in addition to its built-in file/shell tools):
- `propose_failing_tests({ files: [{ path, contents, description }] })` — the agent calls this when it has decided what failing tests to write. The activity then writes each file, runs the test suite to confirm they actually fail, and commits each file as its own commit on the feature branch.
- `request_ac_clarification({ reason, questions: string[] })` — the agent calls this when the AC is too ambiguous to translate into tests. The activity then calls `linearClient.createSubTicket(ticketId, "ac-clarification", …)` with the questions formatted as a checklist, and fails the activity non-retryably.

**Why two explicit tools instead of one tool plus prose?** It collapses the "is the AC ambiguous?" question into a structured decision the agent has to commit to via tool call. We never have to parse natural-language hedging like "it might be ambiguous, but maybe we could…" The agent must pick one tool. If the agent does neither (e.g., returns prose), the activity rejects the run as a failure — that is a model failure mode, not a workflow signal.

**Alternative considered: free-form text + post-hoc parse.** Rejected. Parsing reliability becomes the ceiling on the system. Tool-call structure is exactly what Claude SDK is good at.

**Alternative considered: a single `submit({ outcome: "tests" | "clarification", … })` tool.** Rejected as marginally simpler in code but worse for prompt clarity. Two tools each describe their own preconditions; one polymorphic tool doubles as a docstring riddle.

### 2. Failing-test verification is the activity's responsibility, not the agent's

After `propose_failing_tests` returns, the activity itself runs the test command (`npm test`, `pytest`, or whatever the repo's `devcontainer.json` / `package.json` declares) to confirm the proposed tests *actually* fail. If they pass, the activity rejects the agent's submission and either retries the prompt with a corrective message or fails the activity. This is the test-as-hard-artifact contract: tests that pass on `main` cannot be the spec.

**Why does the activity verify, not trust the agent?** The whole architectural reason for the spec/coder split (concept §3.4) is to prevent the agent from tuning tests to its own implementation. If we let it self-certify "yes these fail," we hand back the failure mode we set out to avoid.

**Alternative considered: have the agent run tests itself via the SDK's shell tool, return a summary.** Rejected for the same reason — the agent's claim that tests fail is exactly what we cannot trust. Verification must run after the agent's tool call and outside its control.

The activity does, however, give the agent the SDK's read-only filesystem tools and the ability to run *exploratory* commands (e.g., `npm ls`, `cat existing-test.spec.ts`) before it commits to `propose_failing_tests`. We just don't trust its post-hoc claim about pass/fail.

### 3. One commit per test file on a fresh feature branch

The feature branch is named `agent/spec-<ticket-identifier-lowercased>` (matching the existing no-op convention). The activity creates the branch from the repo's default branch, writes each proposed test file in turn, and commits each with a message like `test(spec): failing test for <description>` plus a structured trailer including `Workflow-Id`, `Ticket-Id`, `Attempt`, and `Phase: spec`.

**Why one commit per file?** It gives the coder agent (downstream) and the human reviewer a clean per-test diff to read, and it makes `git log --oneline` a readable summary of what the spec agent decided. The cost is a few extra `git commit` invocations — negligible.

**Alternative considered: single squash commit.** Rejected as marginally faster but loses the per-test attribution that matters for reviewing the spec layer.

After commits land locally, the activity pushes the feature branch to `origin` (with `--set-upstream`) so it's visible to the coder phase running in a fresh container. If the push fails (e.g., remote unreachable), the activity throws and Temporal retries on a fresh container.

### 4. Attempts row mapping

The `attempts` schema has columns `(run_id, phase, attempt_index, outcome)` with `outcome IN ('pending', 'passed', 'failed', 'stuck')`. The proposal language uses different terms (`tests-written`, `clarification-requested`); we map them onto the existing enum rather than expanding it:

| Proposal outcome | DB outcome | Notes |
|---|---|---|
| tests-written | `passed` | The spec phase succeeded. The "passed" label here means "phase passed", not "tests passed". |
| clarification-requested | `stuck` | The phase did not produce tests; it surfaced ambiguity for human resolution. |
| Any uncaught exception | `failed` | Internal error, model error, push error, etc. Retried by Temporal until non-retryable. |

A single new activity in `server/src/temporal/activities/attempts.ts` (`recordAttempt({ workflowId, phase, attemptIndex, outcome })`) handles the insert. The spec activity calls it from a `try/finally` so the row is recorded on both success and failure paths.

**Why not a new outcome enum value?** Keeps the `data-persistence` schema spec untouched; the existing four states already cover the semantic axes (pending → working, passed → done, failed → error, stuck → human needed). Adding new values would force a migration for terminology only.

### 5. Prompt lives in `server/src/agents/spec/prompt.md`

The prompt file is loaded at activity startup (not at module import) so changes during dev don't require restarting the worker. It includes:
- The ticket's title and description (interpolated at runtime).
- The names and contracts of the two tools.
- Constraints: tests must fail on the current `main`, must use the framework already declared in the repo, must not modify production code (only test files).
- An anti-shortcut clause: "If the AC is missing concrete acceptance criteria, prefer `request_ac_clarification`. Do not invent assumptions."

The activity reads it via `fs.readFile` at the start of every invocation. It's checked into the repo (not generated).

### 6. Prompt and SDK call run inside the container; the activity is invoked there

Per `container-worker-lifecycle`, `runSpecPhase` is registered on the per-repo container worker and runs inside the container. The Claude SDK call therefore runs from inside the container, which:
- Already has the repo cloned at `/workspace` (or wherever the devcontainer expects it).
- Has read-only access to `/root/.claude` for subscription auth.
- Has the worker bundle at `/opt/furnace` providing the SDK and our activity code.

This means *no host-side execution* of the model — consistent with the proposal's last line. The orchestrator (host) still runs the per-ticket workflow and the `launchWorkerContainer` activity; the spec agent body runs in the container.

The only caveat is that `recordAttempt` writes to the orchestrator's PGLite database. The container worker cannot reach PGLite directly (PGLite is in-process to the orchestrator). So `recordAttempt` is registered as an *orchestrator-only* activity and invoked from the workflow via `proxyActivities` on the orchestrator queue — not from inside `runSpecPhase`. The workflow records the attempt around the spec phase, observing whether it succeeded, failed, or threw a non-retryable `clarification-requested` error.

### 7. Non-retryable failure carries the sub-ticket reference

When the agent calls `request_ac_clarification`, the activity:
1. Calls `linearClient.createSubTicket(parentId=input.ticket.id, type="ac-clarification", body=…, workflowDeepLink=…)`.
2. Throws `ApplicationFailure.nonRetryable("spec.ac_clarification_requested", "AcClarificationRequested", { subTicketRef })`, where `subTicketRef` is the `{ id, identifier, title }` returned by Linear.

The workflow catches `AcClarificationRequested` specifically, transitions to a `paused-pending-human` terminal state, persists `workflow_runs.status = 'failed'` (existing schema does not have `paused`; we use `failed` and rely on the structured failure detail to indicate the human-pause reason), and records the attempt with outcome `stuck`. The Linear ticket state is left in `In Progress` (not `Canceled`) so a human picks it up.

**Why non-retryable?** Retrying the same prompt against the same ambiguous AC will produce the same outcome. Retry only buys cost.

**Alternative considered: open the sub-ticket from the workflow, not the activity.** Rejected. The activity has the model's output (the questions list), so it owns the sub-ticket creation step. Splitting it into a separate activity adds an RPC for no clarity gain. The workflow only needs to know "stuck, sub-ticket X."

### 8. Heartbeat cadence: every 5 seconds plus before each shell tool call

The configured `heartbeatTimeout` is 30s. The activity heartbeats:
- Once at the start (already done by the no-op via `heartbeatStart`).
- Every 5s on a `setInterval` while the SDK is mid-conversation.
- Before each long-running tool execution (test runs, git pushes) so the cadence remains honored even when a single tool call exceeds 5s of uninterrupted work.

The interval is cleared in a `finally` block so cancellation does not leave it dangling.

## Risks / Trade-offs

[**Model returns malformed tool args**] → The SDK validates against tool schemas. A malformed call throws and the activity catches it; we send back a corrective message and let the agent retry within the same SDK conversation up to a small budget (e.g., 3 corrections). Beyond that, the activity throws a retryable error and Temporal launches a fresh container.

[**Tests proposed by the agent pass on `main` (false-failing tests)**] → Verification step in §2 catches this. The activity sends a corrective message naming which proposed tests passed and asks for replacements. Same retry budget as above.

[**Ticket description is empty or missing**] → The agent will call `request_ac_clarification` because there is literally nothing to translate. This is the correct outcome.

[**Sub-ticket creation fails (Linear outage)**] → The activity throws a *retryable* error (not non-retryable) so Temporal retries the whole spec phase. A second attempt may succeed, or eventually we exhaust retries and the workflow fails normally. The clarification request is lost on permanent failure — acceptable as the workflow itself is also surfaced as failed.

[**`@anthropic-ai/claude-agent-sdk` adds significant install size to the container image**] → The SDK is bundled via `npm run build:worker` into the bind-mounted bundle, not baked into the per-repo image, so per-repo image size is unaffected. Worker bundle size grows but is shared across all repos.

[**Per-attempt prompt cost adds up**] → Subscription auth, not API billing, so cost is concurrency not dollars. `CLAUDE_ACTIVITY_CONCURRENCY` already gates parallelism. We add nothing new here.

[**Agent calls neither tool (returns prose)**] → Treated as model failure: corrective message, retry within conversation up to budget, then fail the activity. The non-deterministic risk is that this category is more common than expected; the corrective-message budget is the lever to pull if so.

[**The activity needs `git` and `node` (or whatever test runner) on the container PATH**] → The pre-warmed devcontainer image already has the repo's tooling; that is the invariant `devcontainer-image-build` provides. The spec activity only assumes the repo's own declared test command works.

## Migration Plan

This is a green-field replacement of the no-op activity, not a migration of running data:
1. Add `@anthropic-ai/claude-agent-sdk` to `server/package.json` (orchestrator + worker bundle).
2. Add `server/src/agents/spec/prompt.md`.
3. Add `server/src/agents/spec/activity.ts` exporting the new `runSpecPhase`. Keep the contract-validation entrypoint (`specPhaseInputSchema.parse(input)` and `specPhaseOutputSchema.parse(output)`) intact.
4. Update `server/src/temporal/activities/phases.ts` to re-export from `agents/spec/activity.ts` (the existing import shape `runSpecPhase` from this file is referenced by the workflow and worker registry).
5. Add `recordAttempt` activity in `server/src/temporal/activities/attempts.ts` and register it on the orchestrator worker.
6. Update `perTicketWorkflow` to wrap the spec phase call with `recordAttempt` calls and to recognize `AcClarificationRequested` as the human-pause path.
7. Add unit tests for the new activity body using a stubbed SDK client (no network) and tests for the workflow's clarification path.
8. Verify the existing `temporal.ticketWorkflows.test.ts` integration test still passes — the no-op output shape is preserved by mocking the SDK and tools.

Rollback: revert the proposal commit. The activity falls back to the no-op shape, and `attempts` row writes stop. No data shape change to roll back.

## Open Questions

1. **Where does the repo deep link in the sub-ticket point?** The proposal says "deep link back to the workflow moment" — likely a Temporal Web URL (`<TEMPORAL_WEB_BASE>/namespaces/<ns>/workflows/<id>`). The base URL is not currently in `config.ts`; we add `TEMPORAL_WEB_BASE` env var as part of this change. Default for local dev: `http://localhost:8233`.

2. **What test command does the activity invoke for verification?** Read from `package.json` `"scripts": { "test": "…" }` if present, else fall back to `npm test`. Multi-language repos will need a richer convention later, but the demo repos in scope are TypeScript so this is sufficient.

3. **How does the agent know which directory is the repo root inside the container?** Either an env var the launcher sets (e.g., `WORKER_REPO_PATH=/workspace`) or a fixed convention. The container-worker-lifecycle spec does not currently mandate one. Decision: introduce `WORKER_REPO_PATH` env var, default `/workspace`, and pass it into the prompt's tool descriptions. (This may need a small amendment to the worker-env contract — flagged for follow-up if it grows beyond a default.)

4. **Should we cap the per-conversation correction budget per Risks above?** Tentative answer: 3. Will be visible in code as a constant; revisit after first end-to-end run.
