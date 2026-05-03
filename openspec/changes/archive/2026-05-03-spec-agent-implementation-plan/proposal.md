## Why

Tests alone underspecify intent. The coder agent can satisfy spec-phase tests without delivering the full feature — e.g., a ticket that asks for a backend endpoint *and* a frontend page can pass with backend-only tests if the spec agent didn't write a frontend test, leaving the UI work undone. Tests pin down the parts the spec agent thought to test; an implementation plan pins down everything else the coder must build, in the spec agent's own words, before the coder picks up the branch.

## What Changes

- **BREAKING (internal contract)**: `propose_failing_tests` SDK tool gains a required `implementationPlan` argument. The spec agent must produce both failing tests and a structured plan in the same call.
- `SpecPhaseOutput` (and therefore `coderPhaseInputSchema.specOutput`) gains a required `implementationPlan` field carrying the spec agent's narrative + checklist of work the coder is expected to complete. The plan rides Temporal workflow state — no extra commit on the feature branch.
- The coder prompt template gains a new `{{IMPLEMENTATION_PLAN}}` section rendered above `{{TEST_FILES}}`, and the coder prompt instructs the agent to satisfy *both* the failing tests *and* the plan checklist — surfacing scope mismatch as a `design-question` rather than silently shipping a partial change.
- The spec prompt is extended to require a plan: high-level summary, per-area work items (backend / frontend / config / migrations / docs as applicable), and the relationship between each test and the plan items it covers.
- The PR-open activity (`openPullRequestActivity`) accepts the plan as new input and renders it as an `## Implementation plan` section in the PR body so human reviewers see the spec agent's plan inline alongside the diff.

## Capabilities

### New Capabilities

(none — this is a contract extension across two existing capabilities)

### Modified Capabilities

- `spec-generation`: spec phase now produces an implementation plan in addition to failing tests; plan is surfaced as a required field on `SpecPhaseOutput`. Ambiguity escalation (`request_ac_clarification`) extends to "cannot produce a coherent plan" as a first-class signal.
- `code-generation`: coder phase consumes the plan from `specOutput.implementationPlan`, renders it into the coder prompt, and is instructed to satisfy both tests and the plan; missing scope becomes a `design-question` escalation.
- `github-pr-open`: PR-open activity accepts the plan as input and includes a rendered `## Implementation plan` section in the PR body (above the existing metadata block).
- `ticket-workflow`: per-ticket workflow forwards `specOutput.implementationPlan` into the round-0 `openPullRequestActivity` call.

## Impact

- New required field on a Zod contract shared by two phase activities — both spec and coder unit tests will need updates, and any fixture that constructs a `SpecPhaseOutput` (in tests or workflow integration) must include the new field.
- `openPullRequestActivity` input schema gains a required `implementationPlan` field; the per-ticket workflow forwards `specOutput.implementationPlan` into the activity call. Existing PR-body shape grows but the metadata-block contract is unchanged.
- Coder prompt grows; correction budget unchanged. No new dependencies. No new files committed into target repos.
- No changes to Linear, Temporal, or container-runtime layers.
- Affected files (preview, finalized in design):
  - `server/src/agents/spec/{prompt.md,tools.ts,activity.ts,sdk-client.ts}`
  - `server/src/agents/coder/{prompt.md,activity.ts}`
  - `server/src/agents/contracts/spec-output.ts`
  - `server/src/agents/shared/` — shared plan-Markdown formatter (used by coder prompt + PR body)
  - `server/src/temporal/activities/github.ts` and `server/src/temporal/workflows/per-ticket.ts`
  - Spec/coder/PR-open unit + workflow tests under `server/tests/`
