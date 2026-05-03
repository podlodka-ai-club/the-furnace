## Context

The spec agent (Concept §3.4) splits specification from implementation across two reasoning passes so the coder can't tune tests to its own output. Today the only artifact crossing that boundary is a set of failing test files committed on a feature branch (`SpecPhaseOutput.testCommits`). The coder prompt renders those paths into a `{{TEST_FILES}}` block and instructs the agent to make them pass.

The problem we observed: tests under-specify intent. A ticket like *"Add a settings page that toggles dark mode and persists the choice via the existing PUT /me endpoint"* has roughly three areas of work — backend handler/persistence, frontend page, and (often) a typed client. The spec agent might confidently write only a backend integration test (it is the easiest to express in vitest), and the coder will dutifully implement only the backend. Tests passed, suite green, PR opens, reviewer pushes back, round-trip burned. The spec/coder split shielded us from one failure mode (coder tunes tests) and exposed another (tests are an incomplete spec of intent).

Adding more tests is not the answer — many concerns (UI presence, copy, file structure, dependency choices) are clumsy or impossible to express as tests in a way that won't drive the coder toward fragile assertions. What we need is a *plan in prose*, written by the spec agent, that pins down everything beyond what the tests assert. The coder reads both, treats the tests as the hard contract and the plan as the soft contract, and escalates a `design-question` when the plan asks for something the tests don't cover and the coder can't honor it without a decision.

## Goals / Non-Goals

**Goals:**
- The spec phase produces an implementation plan in the same atomic act as proposing failing tests, so we never get tests without a plan or a plan without tests crossing the spec/coder boundary.
- The plan is a structured artifact (validated by Zod) so downstream consumers (coder prompt today, reviewer/UI later) can rely on its shape.
- The plan rides Temporal workflow state via `SpecPhaseOutput.implementationPlan` — durable across worker restarts and follow-up rounds — so the coder always reads it from a single source.
- Humans see the plan in the PR body via `openPullRequestActivity`, without committing furnace-specific files into the target repo's tree.
- The coder is instructed to satisfy *both* the failing tests and the plan checklist, and to escalate (`report_design_question`) when a plan item cannot be satisfied without a design call — surfacing the scope gap rather than silently shipping a partial change.
- "Cannot produce a coherent plan" becomes a first-class ambiguity signal: the agent calls `request_ac_clarification` instead of guessing at scope.

**Non-Goals:**
- Not introducing a structured task graph, dependency DAG, or per-step commit instructions. The plan is prose + a flat checklist; we keep the spec/coder boundary deliberately coarse.
- Not changing how tests are verified, committed, or pushed — that path stays exactly as it is in `spec-generation`.
- Not adding a separate plan-only escalation tool. Plan ambiguity reuses `request_ac_clarification` (it's the same kind of "ticket is too vague" signal).
- Not doing reviewer-side enforcement of the plan in this change. The reviewer agent already flags scope gaps from the PR diff; tying the plan into reviewer prompts is a follow-up.
- No retroactive plan generation for existing in-flight branches. The change only affects new spec runs.

## Decisions

### 1. Plan shape: prose summary + flat checklist of work items

The plan is a Zod object:

```ts
implementationPlan: {
  summary: string,                // 1–3 paragraphs of intent in the spec agent's words
  workItems: Array<{
    area: "backend" | "frontend" | "config" | "migration" | "docs" | "other",
    description: string,          // what the coder must do for this item
    coveredByTests: boolean,      // whether the failing tests already pin this down
  }>,
}
```

`workItems` is a flat list, not a tree. We considered two alternatives:
- **Free-form Markdown blob.** Easiest for the agent, but downstream consumers would have to parse English. Rejected: we want the coder prompt to format the checklist deterministically, and we expect future consumers (reviewer, dashboard).
- **Structured per-test mapping (each test references plan items).** Tighter coupling, but the spec agent rarely gets that mapping right on first try, and the value is small — the coder reads both the tests and the plan anyway. Rejected as over-engineering.

`coveredByTests` is the load-bearing field. It's how the coder distinguishes "this is enforced by a failing test" from "this is the soft contract you must also honor." When `coveredByTests: false` and the coder cannot satisfy the item, that is exactly the case where escalating `report_design_question` is correct.

`area` is closed-set rather than free string so we can render it consistently and so the spec agent can't sprawl into idiosyncratic categories. `"other"` is the escape hatch.

### 2. Plan is produced atomically with tests, not in a separate tool call

The `propose_failing_tests` tool gains a required `implementationPlan` argument:

```ts
proposeFailingTestsArgsSchema = z.object({
  files: z.array(...).min(1),
  implementationPlan: implementationPlanSchema,
});
```

We considered two alternatives:
- **Add a new `submit_plan` terminal tool, called separately.** This breaks the "exactly one terminal tool call" invariant of the spec agent and complicates the activity's state machine.
- **Optional plan field, default to a stub.** Defeats the point — a missing plan is the same failure mode we have today.

Required + same tool call keeps the spec agent's terminal action atomic and ensures we never persist tests without a plan.

### 3. Plan is *not* committed into the target repo; it rides workflow state and the PR body

The plan lives in two places only:
1. The Temporal workflow's `SpecPhaseOutput.implementationPlan` payload, which already flows into the coder phase as embedded `specOutput`.
2. A rendered Markdown section in the PR body, written by `openPullRequestActivity` from a new `implementationPlan` input field.

Why no file commit into the target repo:
- Committing furnace-specific artifacts into someone else's repository is a higher-blast-radius choice than initially treated. It needs a non-colliding path, may interact with `.gitignore`, and pollutes the diff with non-product content.
- Both consumers of the plan (the coder agent and the PR reviewer) can be served without a commit: the coder reads the structured object directly; the human reviewer reads it as a section in the PR body.
- Workflow state is already durable in Temporal — surviving worker restarts, replays, and follow-up rounds — so the "travel with the branch" argument doesn't add anything beyond what we get for free from `SpecPhaseOutput`.

Why include the rendered plan in the PR body specifically:
- The PR body is already the canonical place we surface workflow context to humans (ticket description, diff summary, workflow-link, metadata block). Adding the plan there is a natural extension rather than a new surface.
- `openPullRequestActivity` already has the workflow-side context to compose the body and is already on the orchestrator queue (not the per-attempt container), so adding a field is mechanical.

Considered alternatives:
- **Commit `.furnace/IMPLEMENTATION_PLAN.md` on the feature branch.** Rejected for the reasons above (target-repo blast radius, no functional gain over the in-payload + in-PR-body path).
- **Plan only in `SpecPhaseOutput`.** Rejected: humans reviewing the PR don't see Temporal payloads, and the spec agent's reasoning becomes invisible to the reviewer.
- **Plan as a separate PR comment instead of in the body.** Rejected: the body is the durable artifact that always shows on the PR landing view; comments are easier to miss and clutter the timeline.

### 4. Coder consumes the plan from `SpecPhaseOutput.implementationPlan`

`coderPhaseInputSchema` already embeds `specPhaseOutputSchema`, so once `implementationPlan` is required on the spec output it flows into the coder input automatically. The coder activity:
1. Renders the plan into a new `{{IMPLEMENTATION_PLAN}}` section in the coder prompt template, placed above `{{TEST_FILES}}`.
2. Renders work items grouped by `area`, with a `(test-covered)` / `(plan-only)` annotation per item driven by `coveredByTests`.
3. Adds prompt language: "Satisfy *both* the failing tests above *and* every plan item below. If a plan item with `(plan-only)` requires a design decision you cannot resolve, call `report_design_question`."

The structured object on the workflow input is the only source the coder reads — there is no plan file in the working tree to fall back to (per §3), so this is the single canonical path by construction.

### 5. Plan ambiguity reuses `request_ac_clarification`

If the spec agent cannot articulate a coherent plan (e.g., the ticket is "make the dashboard better"), it calls `request_ac_clarification` exactly as today. We do not add a `request_plan_clarification` tool — the failure mode is identical to AC ambiguity, and adding a third tool just splits the agent's decision space without giving us new information downstream.

The spec prompt is updated to make this explicit: "If you cannot produce both at least one failing test *and* a plan you stand behind, call `request_ac_clarification`."

### 6. Spec activity is unchanged on the git path; plan only rides the return value

The activity sequence inside `handleProposeFailingTests` is unchanged: write files → run tests → confirm at least one fails → branch → commit each test file → push. The only addition is that the returned `SpecPhaseOutput` now includes `implementationPlan: decision.input.implementationPlan` so it survives across the phase boundary.

Pushing this through workflow state rather than git is also better on the failure path: a false-failing-test correction loop never has the chance to leave a stale plan in the working tree, because there's no plan write to roll back.

### 7. Plan formatter is shared between coder prompt and PR body

The plan-to-Markdown formatter (`formatPlanAsMarkdown`) lives in `server/src/agents/shared/` and is imported by both the coder activity (to render the prompt) and the GitHub PR-open activity (to render the PR body). One implementation, one set of tests, byte-identical output across consumers. Determinism: stable `area` order is `["backend", "frontend", "config", "migration", "docs", "other"]`; within each area we preserve the agent's submission order.

### 8. Coder treats plan items as soft contract; tests stay the hard contract

The coder is *not* given a tool to mark plan items "done" — the only verification mechanism remains the test suite. The plan is prompt-only context, plus a `report_design_question` escape hatch when a `(plan-only)` item cannot be honored without a decision.

We considered enriching `report_design_question` with a `relatedPlanItem` field. Rejected for this change as scope creep — the existing `reason` + `questions` fields are enough for the human to map the question back to the plan in the sub-ticket. Revisit if reviewer/UI needs structured linkage.

## Risks / Trade-offs

- **Spec agent over-plans, generating a plan so detailed that it becomes the prescriptive design.** → Mitigation: prompt language emphasizes the plan is *what* to build, not *how*. We render every work item the agent submits — capping or truncating would diverge the spec contract from the rendered output and create a silent-drop failure mode. A sprawling plan is itself a smell that the ticket is under-decomposed; if we observe it in practice we'll add a Zod-level upper bound on `workItems.length` in a follow-up rather than a render-time cap.
- **Spec agent puts every work item under `area: "other"`, defeating the categorization.** → Mitigation: prompt examples enumerate `backend` / `frontend` / `config` / `migration` / `docs` with one-line definitions; `"other"` is described as "use only if no category fits." Worst case we get a list with poor categorization, which is no worse than free-form Markdown — no functional regression.
- **Coder escalates `report_design_question` for every `(plan-only)` item, blowing up the human queue.** → Mitigation: prompt language explicitly says escalate only when the item is blocking and unresolvable from the codebase context. Tune via the persona reviewer pass once we observe baseline behavior.
- **Schema break ripples through every `SpecPhaseOutput` fixture in tests, plus every `openPullRequestActivity` input fixture.** → Mitigation: provide a `makeSpecPhaseOutputFixture(overrides)` helper alongside the schema change so test updates are mechanical. The set of constructors outside spec/coder/PR-open activities is small (workflow integration tests only).
- **Plan adds tokens to the coder prompt, edging closer to context-window pressure on large tickets.** → Mitigation: the plan shape is naturally bounded by the spec agent's own output (single summary + flat list of items); a typical plan at ~10–15 items adds a few thousand tokens, well under the coder prompt's existing headroom. If we ever hit pressure in practice we'll add a Zod-level `workItems.length` cap (per §3 of Risks above) rather than a render-time truncation.

## Migration Plan

This is internal contract evolution; no live runs to migrate.

1. Land contract change (`spec-output.ts` adds required `implementationPlan`), spec/coder activity updates, prompt updates, and PR-open activity update in a single PR. There is no point landing the contract change ahead of the activity changes — both spec and coder (and PR-open) start failing input/output validation immediately.
2. Update unit and workflow integration tests to construct the new field via a fixture helper.
3. No rollback plan beyond reverting the PR; there is no persistent state to migrate. In-flight workflows when the change deploys will fail validation on resume — acceptable given workflows are short-lived (minutes, not days) and we control the deploy window.

## Open Questions

- Should `coveredByTests` be derived (set automatically by the activity by string-matching plan items against test paths) or claimed by the model? **Tentative:** claimed by the model. Deriving it would require text matching that is brittle, and the model's claim is itself a useful self-reflection signal we can observe.
- Where in the PR body does the plan section go? **Tentative:** above the diff summary, below the ticket description verbatim. Keeps the existing metadata-block contract untouched at the bottom and puts the plan in the "human reading order" of the PR. Finalize during implementation if the spec for `github-pr-open` requires a specific order.
