## 1. Contract: extend `SpecPhaseOutput` with implementation plan

- [x] 1.1 In `server/src/agents/contracts/spec-output.ts`, add `implementationPlanSchema` (Zod): `summary: z.string().min(1)`, `workItems: z.array(z.object({ area: z.enum(["backend", "frontend", "config", "migration", "docs", "other"]), description: z.string().min(1), coveredByTests: z.boolean() })).min(1)`. Export `ImplementationPlan = z.infer<...>`.
- [x] 1.2 Add `implementationPlan: implementationPlanSchema` as a required field on `specPhaseOutputSchema`. Re-export the inferred type from `contracts/index.ts`.
- [x] 1.3 Update existing positive/negative fixtures used by contract tests under `server/tests/agents/contracts/` to include `implementationPlan`; add a negative case for missing plan and an invalid `area`.
- [x] 1.4 Add a `makeImplementationPlanFixture(overrides)` helper alongside the schema (or in a sibling test-fixtures file already used by spec/coder/PR-open tests) so test updates are mechanical.

## 2. Shared plan-Markdown formatter

- [x] 2.1 Create `server/src/agents/shared/plan-format.ts` exporting `formatPlanAsMarkdown(plan: ImplementationPlan): string`. The formatter OWNS the section heading: output begins with `## Implementation plan`, followed by the summary paragraph, then per-area H3 sections (`### Backend`, `### Frontend`, …) with bulleted items annotated `(test-covered)` or `(plan-only)`. Determinism: stable area order = `["backend", "frontend", "config", "migration", "docs", "other"]`; within each area preserve the agent's submission order. Areas with zero items are omitted.
- [x] 2.2 Add unit tests for the formatter under `server/tests/agents/shared/`: output begins with the `## Implementation plan` heading exactly once; byte-identical output across calls; empty-area sections are omitted; closed-set area ordering is enforced regardless of input order.

## 3. Spec agent: tool schema & prompt

- [x] 3.1 In `server/src/agents/spec/tools.ts`, extend `proposeFailingTestsArgsSchema` to require `implementationPlan: implementationPlanSchema`. Update `ProposeFailingTestsArgs` inferred type — verify TypeScript compiles across spec module.
- [x] 3.2 Update `PROPOSE_TOOL_DESCRIPTION` in `server/src/agents/spec/sdk-client.ts` to mention the required plan argument so the SDK surfaces the right tool description to the model.
- [x] 3.3 In `server/src/agents/spec/prompt.md`, expand the `propose_failing_tests` section to describe the `implementationPlan` argument: required `summary`, required `workItems[]` with closed-set `area`, `description`, and `coveredByTests` boolean. Add an example payload. Include guidance that `coveredByTests=false` items must be ones the coder would otherwise miss without the plan.
- [x] 3.4 In `server/src/agents/spec/prompt.md`, expand the anti-shortcut clause: "If you cannot produce both at least one failing test AND a coherent plan, call `request_ac_clarification` rather than ship a partial plan."

## 4. Spec activity: thread plan through `SpecPhaseOutput`

- [x] 4.1 In `server/src/agents/spec/activity.ts` `handleProposeFailingTests`, include `implementationPlan: decision.input.implementationPlan` (i.e., the validated payload from the tool call) in the `output` object returned, so `specPhaseOutputSchema.parse(output)` succeeds.
- [x] 4.2 Confirm there are no other code paths in the spec activity that construct or return a `SpecPhaseOutput`. The activity MUST NOT write any plan file into the target repo working tree or create any commit beyond the per-test-file commits.

## 5. Coder activity: render plan into prompt

- [x] 5.1 In `server/src/agents/coder/prompt.md`, insert the bare `{{IMPLEMENTATION_PLAN}}` placeholder above the existing `## Failing tests committed by the spec agent` section — DO NOT add a surrounding `## Implementation plan` heading in the template, since the formatter (§2.1) emits its own H2 heading. Update prompt language elsewhere in the template to instruct the agent that satisfying tests is required AND that every plan item must be honored, escalating unresolvable `(plan-only)` items via `report_design_question`.
- [x] 5.2 In `server/src/agents/coder/activity.ts` `renderPrompt(...)`, render the plan via `formatPlanAsMarkdown(specOutput.implementationPlan)` (from §2.1) and replace `{{IMPLEMENTATION_PLAN}}` with the rendered string. Verify the coder activity does NOT read any plan-bearing file from the working tree.
- [x] 5.3 Add a coder unit test asserting the rendered prompt contains exactly one `## Implementation plan` heading (regression guard against duplicating it in the template).

## 6. PR-open activity: include plan in PR body

- [x] 6.1 In `server/src/temporal/activities/github.ts`, extend the `openPullRequestActivity` input schema to require `implementationPlan` matching the schema from §1.1.
- [x] 6.2 In the PR-body composition function, render the plan via `formatPlanAsMarkdown(implementationPlan)` and insert it after the ticket description and before the diff summary. The formatter emits its own `## Implementation plan` heading; the body composer MUST NOT add another. Do not change the metadata-block contract (keys, order, delimiters).
- [x] 6.3 In `server/src/temporal/workflows/per-ticket.ts`, forward `specOutput.implementationPlan` into `openPullRequestActivity` at the round-0 invocation site (around `pr = await openPullRequestActivity({ ... })`).
- [x] 6.4 Update PR-open unit tests under `server/tests/temporal/activities/` (or wherever the activity's body-composition tests live): every fixture must include a plan; positive test asserts the body contains a single `## Implementation plan` section in the prescribed position with byte-identical Markdown to `formatPlanAsMarkdown(plan)`; metadata block is unchanged.

## 7. Spec & coder tests

- [x] 7.1 Update spec activity unit tests under `server/tests/agents/spec/` so every fixture passing through `propose_failing_tests` includes a valid `implementationPlan`. Add a positive test asserting the returned `SpecPhaseOutput` carries the plan verbatim.
- [x] 7.2 Add a negative spec test: agent submits `propose_failing_tests` with no `implementationPlan` → activity sends a corrective message, increments correction count, and exhaustion of budget yields a retryable `SpecAgentBudgetExhausted` failure.
- [x] 7.3 Add a spec test asserting that on every code path (success, false-failing-test correction, AC clarification) the activity does not write any non-test file into the target repo working tree.
- [x] 7.4 Update coder activity unit tests under `server/tests/agents/coder/` so every `coderPhaseInputSchema`-constructed fixture includes an `implementationPlan` on `specOutput`. Add a positive test asserting that the rendered prompt contains the plan summary and the work-item annotations (`(test-covered)` / `(plan-only)`), placed above the test-files block.
- [x] 7.5 Add a contract-level test in `server/tests/agents/contracts/` asserting that `specPhaseOutputSchema.parse(...)` rejects an output missing `implementationPlan` and rejects an `area` outside the closed set.

## 8. Workflow integration & verification

- [x] 8.1 Update any workflow integration test fixtures (`server/tests/workflows/...` / `server/tests/integration/...`) that build a `SpecPhaseOutput` so they include the plan. Use the fixture helper from §1.4. Confirm the round-0 PR-open invocation receives the plan.
- [x] 8.2 Run `TEMPORAL_TASK_QUEUE=local-test npm test` from the repo root and confirm the suite is green.
- [x] 8.3 Confirm no usages of `SpecPhaseOutput` outside `server/src/agents/{spec,coder}/`, `server/src/temporal/`, and tests need updating (grep). If any do, update them or document why they don't need the plan.
