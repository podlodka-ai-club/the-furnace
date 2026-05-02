## Context

The per-ticket workflow now has a real spec phase (`server/src/agents/spec/activity.ts`) that produces a feature branch with one failing-test commit per file, pushed to `origin`. The downstream `runCoderPhase` is still a no-op in `server/src/temporal/activities/phases.ts` that returns a placeholder `CoderPhaseOutput` with `finalCommitSha = "b".repeat(40)` and a fake test-run summary. The workflow consumes that output, advances to the no-op review phase, and finishes — there is no implementation work being done yet.

The substrate this change runs on already exists:
- `launchWorkerContainer` boots a per-attempt ephemeral container with the repo at `WORKER_REPO_PATH` (default `/workspace`), `~/.claude` bind-mounted read-only for subscription auth, and the worker bundle at `/opt/furnace`.
- The Claude Agent SDK is already a dependency (added by `spec-agent`) and is available inside the container via the worker bundle.
- `coderPhaseOutputSchema` (in `server/src/agents/contracts/coder-output.ts`) already requires `featureBranch`, `finalCommitSha`, `diffStat`, `testRunSummary`, and an optional `escalation` (`subTicketRef`) — so the contract for both the green-tests and the stuck paths is already defined.
- `linearClient.createSubTicket(parentId, type, body, deepLink)` accepts `dep-missing` and `design-question` as types alongside `ac-clarification` (see `server/src/linear/types.ts`). No new Linear contracts are needed.
- The orchestrator no longer has a database (the `drop-orchestrator-db` change removed PGLite, the `attempts` table, the `recordAttempt` activity, and the workflow-run persistence activities). Per-attempt outcomes are observed via Temporal workflow history and search attributes; structured failure detail rides on `ApplicationFailure` types. The proposal's "writes an `attempts` row per iteration" language predates the DB drop and is reinterpreted in this design as "Temporal records the activity outcome per attempt."
- The workflow already understands one structured "human-pause" failure type from the spec phase (`AcClarificationRequested`). The coder phase needs the same shape for its two stuck cases (`DepMissingRequested`, `DesignQuestionRequested`).
- The spec-agent design and code (`server/src/agents/spec/activity.ts` + `repo-ops.ts` + `agent.ts` + `tools.ts` + `sdk-client.ts`) is the working blueprint for an in-container Claude SDK activity with custom terminal tools, heartbeats, dependency-injected SDK client, and corrective-message budget. The coder activity should reuse the same shape and the shared `repo-ops.ts` helpers wherever possible.

What is missing is a coder-phase body that:
1. Checks out the spec agent's feature branch inside the per-attempt container (the branch already exists on `origin` from the spec phase).
2. Drives the Claude Agent SDK to iterate read-tests → edit-production-code → run-tests until tests are green or the agent declares it is stuck.
3. Verifies tests really pass (the agent's claim is not authoritative — same trust posture as the spec phase, in reverse).
4. Commits the implementation as a single commit on the feature branch and pushes it.
5. Surfaces stuck states via typed Linear sub-tickets (`dep-missing`, `design-question`) and non-retryable workflow failures, mirroring `AcClarificationRequested`.

The change is constrained by:
- Subscription auth, not API billing — concurrency is the scarce resource. `CLAUDE_ACTIVITY_CONCURRENCY` already gates parallelism on the orchestrator side.
- Per-attempt ephemerality (concept §3.6): each Temporal retry is a fresh container with a clean clone. State that needs to survive must be pushed to `origin`.
- Determinism boundary: the activity body runs in an activity (not a workflow), so spawning `git`, running tests, and making network calls is fine. But heartbeats inside `heartbeatTimeout: 30s` are mandatory for cooperative cancellation.
- One Claude SDK conversation per activity attempt. Cross-attempt retries do not share context — that is exactly the property concept §3.6 wants.
- The coder must NOT modify test files committed by the spec phase. Tuning the spec to the implementation is the failure mode the spec/coder split exists to prevent (concept §3.4).

Stakeholders: coder-agent change owner (this proposal), spec-agent (upstream producer of `SpecPhaseOutput`), persona-reviewers (downstream consumer of `CoderPhaseOutput`), `ticket-workflow` (orchestrates the phase ordering and stuck-state handling).

## Goals / Non-Goals

**Goals:**
- Replace `runCoderPhase` no-op with a real activity that drives the Claude Agent SDK inside the container to make the spec's failing tests pass on the same feature branch.
- Make "stuck on missing dependency" and "stuck on design question" structured tool decisions, not free-form text the activity has to parse.
- Surface per-attempt outcomes (`passed`, `stuck`, `failed`) via Temporal workflow history and `ApplicationFailure` types — not via an orchestrator database row.
- Keep the activity boundary contract-validated: input parses against `coderPhaseInputSchema` (a thin alias for the existing `specPhaseOutputSchema` plus the ticket reference), output parses against `coderPhaseOutputSchema`.
- Reuse `server/src/agents/spec/repo-ops.ts` helpers (run-command, commit, push, default-branch resolution, test-command resolution) instead of duplicating them. Move shared helpers up a directory if needed.
- Heartbeat on the same 5s cadence as the spec activity, including before each long-running tool execution.
- Surface stuck failures (`DepMissingRequested`, `DesignQuestionRequested`) via `ApplicationFailure.nonRetryable` so the workflow can pause without burning Temporal retries.

**Non-Goals:**
- Running the spec or review phases (separate, already-defined activities).
- Multiple commits per attempt. The coder produces one commit on success; per-edit commits would leak the agent's churn into PR review without buying anything.
- Persona-reviewer logic of any kind.
- Cross-attempt context (RAG over prior attempts, retry-aware prompts, etc.). Each attempt is a fresh container; that property is load-bearing for replay.
- Provenance store / structured tool-output hashing. Logged for now; later change.
- Multi-language test runner heuristics beyond what `resolveTestCommand` already offers (read `package.json` `scripts.test`, fall back to `npm test`).
- Allowing the coder to edit non-source files outside the test exclusion (e.g., `package.json` to add a dependency). If the agent thinks it needs a new dependency, it must call `report_dep_missing`.

## Decisions

### 1. Three-tool agent surface: `submit_implementation`, `report_dep_missing`, `report_design_question`

The Claude Agent SDK is given exactly three custom terminal tools (in addition to its built-in Read/Glob/Grep/Bash/Edit/Write tools, see Decision 4):

- `submit_implementation({ summary })` — the agent claims it has finished editing and the spec's previously-failing tests now pass. The activity then runs the test command itself, verifies, commits, and pushes.
- `report_dep_missing({ reason, dependency, questions })` — the agent has determined a dependency the implementation requires is not available in the repo (e.g., a library not in `package.json`, a service unreachable from the container). The activity opens a `dep-missing` Linear sub-ticket and fails non-retryably.
- `report_design_question({ reason, questions })` — the agent has determined that finishing the implementation requires a design-level decision a human should make (e.g., "should this new endpoint be added to the existing controller, or split into a new module?"). The activity opens a `design-question` Linear sub-ticket and fails non-retryably.

**Why three tools instead of one polymorphic tool?** Same reasoning as the spec agent's two-tool surface: each tool's preconditions are a docstring the model reads before calling. Collapsing them into `report_stuck({ kind: "dep-missing" | "design-question", … })` doubles as a riddle the prompt has to repair. Three tools, three explicit decision shapes.

**Alternative considered: one stuck tool with a `kind` discriminator.** Rejected. The Linear sub-ticket type is already a closed enum (`SUPPORTED_SUB_TICKET_TYPES`); having one tool per type maps 1-1 onto that enum and keeps the prompt-side surface symmetric with the spec agent.

**Alternative considered: a single `submit({ outcome: "tests-green" | "stuck", … })` tool.** Rejected for the same prompt-clarity reason.

**Alternative considered: have the agent self-report tests green inline (no terminal tool, parse "done" from prose).** Rejected for the same reasons §1 of the spec design rejects parse-the-output: parsing reliability becomes the system's ceiling.

### 2. Activity verifies tests, not the agent

After `submit_implementation`, the activity itself runs the repo's declared test command (`resolveTestCommand` from `repo-ops.ts`) inside the container and checks that the suite passes (exit code 0). The agent's claim that "tests are green" is not authoritative.

This mirrors the spec-agent's verification step in reverse: the spec agent could lie that tests fail (and have them silently pass on `main`); the coder agent could lie that tests pass (when in fact they still fail). Both failure modes are eliminated by the activity running the suite outside the agent's control.

If the suite still has failing tests, the activity sends a corrective message to the agent in the same SDK conversation, naming the failing tests (parsed best-effort from the runner output, same as `classifyTestRun`), and asks for another iteration. Capped at the same correction budget the spec agent uses (3, exposed as `CODER_CORRECTION_BUDGET`). Beyond the budget, the activity throws a retryable `ApplicationFailure` so Temporal launches a fresh container — exactly the property concept §3.6 makes load-bearing.

**Why does the activity re-run tests, even though the SDK has Bash and the agent likely ran them itself?** The agent ran them whenever it chose; we run them after its terminal tool call, with our exact CWD and command resolution, so the result is reproducible from the activity's perspective. We do not rely on the agent's last-observed test run.

### 3. Activity verifies test files were not modified

After `submit_implementation`, the activity computes the diff against the spec phase's `featureBranch` HEAD-on-arrival (i.e. before any agent edits) and rejects the submission if any of the test files committed by the spec agent appear as modified. Path-based rejection: `SpecPhaseOutput.testCommits[].path` is the canonical list.

The check uses `git diff --name-only <pre-agent-sha> HEAD -- <test-paths>` after the activity has staged the agent's changes. If any path comes back, the activity sends a corrective message ("you modified <path>; revert it and edit only production code") and asks the agent to retry within the same SDK conversation — sharing the same correction budget as Decision 2.

**Why path-based rejection rather than a custom write_code tool that filters paths?** The agent uses the SDK's built-in Edit/Write tools to iterate quickly between Read/Bash test runs. Replacing them with a custom tool that re-implements file editing would either be lossy (agent loses the SDK's path-aware diff) or amount to wrapping Edit with a path filter, which is the same enforcement as a post-hoc git diff but with more code. A post-hoc check on the diff is the simplest backstop; the prompt's anti-tuning clause is the primary signal.

**Alternative considered: a chmod-readonly approach (make test files read-only on disk before invoking the SDK).** Rejected as fragile: the agent could `chmod` them back via Bash, and we still want a clean failure message naming which paths it touched.

**Alternative considered: trust the prompt and skip the diff check.** Rejected. Concept §3.4 puts the spec/coder split exactly here; "trust the prompt" is the failure mode it exists to prevent.

### 4. Built-in SDK tools available to the coder

The coder gets the read-only set the spec agent gets (Read, Glob, Grep, Bash) plus Edit and Write, because iterating code inside one SDK conversation is the natural shape of the coder's work. The MCP server hosting our three custom terminal tools is the same in-process pattern as the spec agent.

**Why include Bash?** The agent will run the repo's tests between edits to know whether it is converging. We do not gate this; the activity's verification step is the trust boundary.

**Why include Write (in addition to Edit)?** The coder may need to create new production source files (a new module, helper, or fixture). Edit-only forbids new-file creation.

**What we deliberately do NOT include:** any tool that opens network connections beyond what Bash already exposes. The container's egress posture is set by the devcontainer image, not by the SDK toolset; we do not narrow it further here.

### 5. One commit per attempt on the existing feature branch

The activity does not create a new branch. It checks out `featureBranch` from `origin` (already pushed by the spec phase), the agent iterates, and on `submit_implementation` + verification success, the activity:

1. Runs `git add --all` in the repo root (after the test-file diff check has passed).
2. Commits with subject `feat(coder): make spec tests green for <ticket-identifier>` plus a structured trailer matching the spec-phase commit format (`Workflow-Id`, `Ticket-Id`, `Attempt`, `Phase: coder`).
3. Pushes the branch with `git push origin <featureBranch>` (no `--set-upstream` — it is already tracked from the spec push).

**Why one commit per attempt instead of one commit per logical change?** The agent's edits are inherently churn-shaped: Edit-Bash-Edit-Bash. Giving the reviewer (human or persona) a single coherent diff is what concept §3.4 promises ("tests as the artifact interface"). Per-edit commits expose internal model state that has no review value.

**Alternative considered: squash the agent's per-edit commits at push time.** Rejected as marginally worse: the agent never made per-edit commits in the first place because Edit/Write don't auto-commit, so we are not squashing — we are making the only commit. Same net effect, simpler code path.

**Why the same feature branch the spec phase used?** That is the single artifact identity for this ticket; `coderPhaseOutputSchema.featureBranch` reflects it. If the coder branched off, the review phase would have to merge two branches before it could read the diff.

### 6. Stuck-state handling and outcome surfacing via Temporal

When the agent calls `report_dep_missing` or `report_design_question`, the activity:

1. Formats `questions` as a Markdown checklist (reusing `buildClarificationBody` shape, generalized to take an arbitrary `reason` and `questions`).
2. Builds the workflow deep link from `TEMPORAL_WEB_BASE` (already in `config.ts` from the spec change).
3. Calls `linearClient.createSubTicket(input.ticket.id, "<dep-missing"|"design-question">, body, deepLink)`.
4. Throws `ApplicationFailure.nonRetryable(message, "DepMissingRequested" | "DesignQuestionRequested", { subTicketRef })` carrying the sub-ticket detail.

The orchestrator no longer writes an `attempts` row (the table and the `recordAttempt` activity were removed by the `drop-orchestrator-db` change). Per-attempt outcomes are observable via Temporal's own surface:

| Coder result | Observable as | Notes |
|---|---|---|
| `submit_implementation` + verification pass | Activity completion event with `CoderPhaseOutput` payload in workflow history | Tests green, branch pushed, output returned. |
| `report_dep_missing` | `ApplicationFailure` with `type = "DepMissingRequested"` and `details.subTicketRef` in the activity-failure event | Sub-ticket opened, workflow paused. |
| `report_design_question` | `ApplicationFailure` with `type = "DesignQuestionRequested"` and `details.subTicketRef` | Same as above with a different sub-ticket type. |
| Correction-budget exhausted / push failure / SDK error | Retryable `ApplicationFailure`; once Temporal retries are exhausted, the activity-failure event carries the final cause | Each retry is a fresh container per concept §3.6. |

**Why no orchestrator-side row?** The `drop-orchestrator-db` change committed to "outcomes are observed via Temporal history, not via a SQL row that duplicates it." This change inherits that posture. If a downstream consumer needs queryable attempt state, it adds a real datastore as part of its own scope.

The workflow integration lives in `perTicketWorkflow`: a `try`/`catch` around `runCoderPhase` that recognizes `DepMissingRequested` and `DesignQuestionRequested` as human-pause signals (analogous to the existing `AcClarificationRequested` path) and skips to the workflow's terminal state without invoking the review phase. The structured failure detail flows through the workflow's own failure event so operators can read the sub-ticket reference from Temporal Web.

### 7. Linear ticket state on stuck

When the coder phase opens a `dep-missing` or `design-question` sub-ticket, the parent ticket SHALL remain in `In Progress`. The workflow MUST NOT cancel the ticket — a human is expected to resolve the sub-ticket. This mirrors the AC-clarification path: humans take over from "In Progress", not from "Canceled".

### 8. Prompt and SDK call run inside the container

`runCoderPhase` is registered on the per-repo container worker (same task queue as `runSpecPhase`). The Claude SDK call therefore runs from inside the container, with `~/.claude` for auth and the repo at `WORKER_REPO_PATH`. No host-side execution.

### 9. Prompt lives in `server/src/agents/coder/prompt.md`, loaded at runtime

Same convention as the spec agent. Loaded via `fs.readFile` at activity entry (not module import), so dev edits don't require a worker restart. Placeholders interpolated at runtime: `{{TICKET_IDENTIFIER}}`, `{{TICKET_TITLE}}`, `{{TICKET_DESCRIPTION}}`, `{{WORKER_REPO_PATH}}`, `{{FEATURE_BRANCH}}`, and `{{TEST_FILES}}` (a bullet list of paths the spec phase committed, so the agent knows which files are read-only).

The prompt MUST include:
- The ticket title and description (so the agent has the user-facing intent, in addition to the tests as the formal contract).
- The feature branch name and the list of spec-phase test paths (the read-only set for the diff check in Decision 3).
- Descriptions of the three terminal tools, including the prohibition on tuning tests to the implementation.
- An anti-shortcut clause for the dep-missing and design-question paths: "If you find yourself wanting to add a new dependency or rearchitect modules to make the tests pass, prefer the corresponding stuck tool. Inventing scope creep is a worse failure than asking for help."
- A statement that the activity will run tests itself; the agent is not the verifier.

### 10. Heartbeat cadence: every 5 seconds, plus before each shell tool call

Identical to the spec activity. The configured `heartbeatTimeout` is 30s. The activity heartbeats:
- Once at the start.
- Every 5s on a `setInterval` while the SDK is mid-conversation.
- Immediately before each test run, git operation, or push so cadence is honored when a single command exceeds 5s.
- The interval is cleared in a `finally` block.

### 11. Activity input contract: a thin extension of `SpecPhaseOutput`

The coder phase needs the spec output (feature branch + per-test paths), but it also needs the original ticket — the prompt must include title and description. The workflow currently calls `runCoderPhase(specOutput)` with just the spec output. We extend the input shape to `{ ticket: ReviewerTicket, specOutput: SpecPhaseOutput }` defined in `server/src/agents/coder/activity.ts` as `coderPhaseInputSchema` and update the workflow's call site accordingly.

This is a strict superset of the current call contract, so the workflow change is local: the only mutation is `runCoderPhase({ ticket: input.ticket, specOutput })` rather than `runCoderPhase(specOutput)`. The output contract (`CoderPhaseOutput`) is unchanged.

**Alternative considered: refetch the ticket inside the activity.** Rejected. The ticket already flows through the workflow input; refetching from Linear would add latency, a possible failure mode (Linear outage on a hot path), and a dependency on Linear from the per-repo worker just to read a string we already have.

### 12. Shared repo-ops helpers move from `agents/spec/` to `agents/shared/`

`repo-ops.ts` was written for the spec agent but the coder needs `defaultRunCommand`, `resolveTestCommand`, `getDefaultBranch`, `pushBranch`, and a generalized `commitFile`/`buildCommitMessage`. Rather than re-import from the spec module (introducing a coder→spec dependency at the source level), move `repo-ops.ts` to `server/src/agents/shared/repo-ops.ts` and update the spec activity's import.

The coder also needs two helpers that the spec didn't:
- `checkoutFeatureBranch(ctx, branch)` — fetches the branch from `origin` and checks it out, asserting the working tree is clean.
- `diffPathsTouched(ctx, basisRef, paths)` — returns the subset of `paths` modified between `basisRef` and `HEAD` (used for the test-file rejection check).
- `commitAll(ctx, subject, trailer)` — single commit covering the agent's diff (analogous to per-file `commitFile`, but staging all and committing once).

These get added to `agents/shared/repo-ops.ts`.

**Why move and share rather than duplicate?** Two activities running essentially the same git/test-command shell code with two copies of `defaultRunCommand` would diverge under maintenance. The shared module keeps both activities single-responsibility for prompt + agent loop + decision tools; everything substrate-flavored lives in one place.

### 13. SDK client class is parameterized, not duplicated

`SdkSpecAgentClient` (`server/src/agents/spec/sdk-client.ts`) is bespoke: hard-coded MCP server name, tool descriptions, and built-in tool list. We refactor it into a parameterized base in `server/src/agents/shared/sdk-session.ts` that both activities consume:

```ts
interface AgentSessionConfig<TDecision> {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  signal: AbortSignal;
  builtInTools: ReadonlyArray<"Read" | "Glob" | "Grep" | "Bash" | "Edit" | "Write">;
  mcpServerName: string;
  toolDefinitions: AgentToolDefinition<TDecision>[];
}
```

The coder client passes its three terminal tools and the expanded built-in set; the spec client keeps its two terminal tools and read-only built-in set. The `pump` loop, `deliver` mechanic, input-stream plumbing, CLI-spawn diagnostics, and end-of-turn handling are shared.

**Why the refactor now?** Two near-duplicates of `SdkSpecAgentSession` would each carry the CLI-spawn diagnostics and the abort-controller plumbing. Sharing the base is cheaper than maintaining two. The refactor is contained — the spec activity's behavior is unchanged.

**Alternative considered: leave the spec SDK client alone and write a parallel `SdkCoderAgentClient`.** Rejected. The shared shape is unmistakable and the two activities will likely accrete more in lockstep (auth diagnostics, structured logging, etc.).

## Risks / Trade-offs

[**Agent edits a test file despite the prompt prohibition**] → Caught by the diff check in Decision 3. Corrective message asks the agent to revert; budget shared with the test-failure correction loop. If exhausted, retryable failure → fresh container, no corruption persists because the agent's edits never committed.

[**Agent calls `submit_implementation` while tests still fail**] → Caught by Decision 2's verification step. Corrective message names the failing tests; same budget, same retry posture.

[**Agent loops indefinitely on Edit-Bash without ever calling a terminal tool**] → The SDK's per-conversation rate limiting + the activity's `startToCloseTimeout: 10 minutes` (already configured in `dispatch.ts`) bound the conversation. When the timeout hits, Temporal cancels the activity (the abort signal is wired to `AbortController` in the SDK call) and retries on a fresh container if any retries remain. Budget the runtime so 10 minutes is workable; if not, raise the timeout in dispatch later.

[**Agent calls a stuck tool when the failure mode is actually solvable**] → False stuck rate is a subscription-cost trade-off (each false stuck is a Linear sub-ticket and a paused workflow). Not solvable architecturally; the prompt's anti-shortcut clause and the cap on correction budget jointly bias the agent to try harder before declaring stuck. We accept the tradeoff.

[**Tests pass on the verification run but fail on a subsequent persona-review run**] → Possible if the test suite has flakiness. Out of scope for this change; the persona phase will be its own retry/quarantine surface in a later change.

[**Sub-ticket creation fails (Linear outage) on the stuck path**] → Same handling as the spec activity: throw a *retryable* error. Temporal retries the activity on a fresh container; the agent rediscovers the stuck state and re-attempts the sub-ticket creation on the next attempt. Permanent Linear outage exhausts retries and the workflow surfaces as failed.

[**Agent introduces a new dependency by editing `package.json` and committing it**] → Edge case: the test-file diff check (Decision 3) does not block `package.json`. Two mitigations: the prompt explicitly says "if you need a new dependency, call `report_dep_missing`", and the persona-reviewer phase (downstream change) will catch it as a review finding. Not an architectural defense — a process one. Acceptable for MVP.

[**Push to `origin` fails (network, auth)**] → Throw retryable; Temporal retries with a fresh container. Same as spec phase. Permanent failure surfaces as a workflow failure.

[**Two coder attempts race on the same feature branch (e.g., a manual workflow restart)**] → Per-attempt ephemerality and Temporal's serial activity dispatch make this nearly impossible in normal operation. If it happens, the second push is a fast-forward (no commits diverge because each attempt starts from `origin/<featureBranch>`), or it fails non-fast-forward and Temporal retries. Acceptable.

[**Repo's test command is interactive or watches for changes**] → `resolveTestCommand` invokes `npm test --silent` (or `npm test`); if a repo's `scripts.test` is `vitest --watch` or similar, the activity hangs until heartbeat timeout. The pre-warmed image's `scripts.test` is curated by the repo owner; we accept this as a "broken devcontainer config" failure mode rather than encoding interactivity detection.

[**`@anthropic-ai/claude-agent-sdk` rate limit / authentication failure inside the container**] → Same shape as spec phase. The SDK throws, the pump catches and delivers a `malformed_tool_call` decision, and the activity sends a corrective message — except the corrective message will not help because auth doesn't recover. The correction budget exhausts, retryable error fires, Temporal retries on a fresh container. Eventually retries exhaust and the workflow surfaces as failed. A production system would short-circuit on auth errors (non-retryable); we keep the behavior simple for MVP and revisit when first encountered.

[**Refactor of `SdkSpecAgentClient` into a shared base introduces a regression in the spec activity**] → Tests for the spec activity already cover its behavior (`server/src/agents/spec/*.test.ts` per the spec-agent change). The refactor must keep all of them green. Risk is real but bounded.

## Migration Plan

This is a green-field replacement of the no-op coder activity, plus a contained refactor of the SDK client and `repo-ops.ts` into a shared module. No data migration.

1. Move `server/src/agents/spec/repo-ops.ts` to `server/src/agents/shared/repo-ops.ts`. Update the import in `server/src/agents/spec/activity.ts`.
2. Add `checkoutFeatureBranch`, `diffPathsTouched`, and `commitAll` to `server/src/agents/shared/repo-ops.ts`.
3. Refactor `server/src/agents/spec/sdk-client.ts` to compose a parameterized base in `server/src/agents/shared/sdk-session.ts`. Spec activity behavior must be unchanged; existing spec tests must stay green.
4. Add `server/src/agents/coder/prompt.md`.
5. Add `server/src/agents/coder/tools.ts` with `submit_implementation`, `report_dep_missing`, and `report_design_question` argument schemas.
6. Add `server/src/agents/coder/agent.ts` mirroring `agents/spec/agent.ts`'s session/decision typing.
7. Add `server/src/agents/coder/sdk-client.ts` consuming the shared base.
8. Add `server/src/agents/coder/activity.ts` exporting `runCoderPhase` (same DI surface as spec activity, with the test-file diff check and single-commit push as the new logic).
9. Update `server/src/temporal/activities/phases.ts` to re-export `runCoderPhase` from `agents/coder/activity.ts`.
10. Update `perTicketWorkflow` (`server/src/temporal/workflows/per-ticket.ts`) to (a) pass `{ ticket, specOutput }` to `runCoderPhase` and (b) catch `DepMissingRequested` and `DesignQuestionRequested` analogously to `AcClarificationRequested`.
11. Add unit tests for the coder activity using a stubbed SDK client: success path, false-pass correction loop, test-file-modification correction loop, prose-only correction loop with budget exhaustion, `report_dep_missing` happy path, `report_design_question` happy path, Linear outage retryable error path.
12. Add workflow tests: stuck path for each of the two stuck failure types, success path through coder, generic failure path.

Rollback: revert the proposal commit. The activity falls back to the no-op shape; the workflow's success path no longer requires an extended input. If the spec-agent SDK client refactor needs to be rolled back independently, revert just commit (3); behavior is unchanged either way.

## Open Questions

1. **Should the coder activity allow the agent to add new dependencies (i.e., write to `package.json`) and have us run `npm install` automatically?** Tentative: no, surface as `report_dep_missing` instead. Allowing autonomous dependency addition expands attack surface (supply-chain) and review burden. Revisit if false-stuck rate on dep-missing is high enough to warrant a curated "preinstalled-extras" allowlist.

2. **What's the right correction budget?** Tentative: 3, matching the spec agent's `SPEC_CORRECTION_BUDGET`. Spec agent's path has tighter convergence properties (one-shot tool call → verify) than coder's (iterative edits → verify). May need to be higher for coder; revisit after first end-to-end run.

3. **Should the coder commit message include a summary of which tests now pass?** Tentative: no, the diff and the trailer are sufficient; the persona reviewers will read the test names directly. Revisit if review surface area is poor.

4. **Should the coder receive the full agent transcript in a stuck sub-ticket body (so the human sees what was tried)?** Tentative: no for MVP — body is the agent's own questions and reason. Adding transcript dump is a provenance-store concern, deferred to that change.

5. **Does the persona-review phase need access to the agent's edit history beyond `git log -p`?** Open. If yes, the coder activity may need to write a structured manifest. For now, `git diff` between the spec-phase HEAD and the coder commit is enough.
