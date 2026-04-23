## Why

Concept §2 pipeline passes artefacts between phases — Linear ticket → failing tests → green tests + diff → votes → merge decision — but the shape of each artefact is currently fixed only in prose scattered across individual proposals (`spec-agent`: *"branch + test-commit manifest"*, `coder-agent`: *"diff manifest"*, `persona-reviewers`: inline `{ vote, reasoning, flags[] }`). Without a single schema each phase interprets its neighbour's shape on its own: the spec agent returns one test manifest, the coder expects another; reviewers guess the vote shape; future V1+ personas (red-team, shadow reviewer) each need their own adapter; eval suites break on every prompt tweak.

This is exactly the failure class thesis §1 tells us to eliminate by construction rather than catch with integration tests after the fact. A single source of truth for inter-agent I/O makes drift inexpressible: an activity that returns the wrong shape fails at the `schema.parse()` boundary instead of silently propagating a broken artefact to the next phase.

## What Changes

- Add `zod` dependency (runtime validation at activity boundaries plus static types via `z.infer`).
- Create `server/src/agents/contracts/` — a single module for inter-agent schemas, one file per pipeline boundary:
  - `spec-output.ts` — `SpecPhaseOutput = { featureBranch, testCommits: Array<{ sha, path, description }>, acClarification?: SubTicketRef }`.
  - `coder-output.ts` — `CoderPhaseOutput = { featureBranch, finalCommitSha, diffStat, testRunSummary, escalation?: SubTicketRef }`.
  - `reviewer-io.ts` — `ReviewerInput` (green tests + diff + ticket metadata) and `ReviewerVote = { vote: "approve"|"reject", reasoning, flags: Array<{ category, severity, message, location? }> }`.
  - `aggregator-io.ts` — `AggregatorInput = { votes: ReviewerVote[], personas: PersonaId[] }`, `AggregatorOutcome = "auto-merge" | "human-tiebreak"`.
  - `shared.ts` — common types (`SubTicketRef`, `DiffStat`, `TestRunSummary`, `PersonaId`).
  - `index.ts` — re-export the full set.
- Export inferred TS types alongside each schema (`export type SpecPhaseOutput = z.infer<typeof specPhaseOutputSchema>`).
- Establish the convention: every phase activity validates its input via `schema.parse()` on entry and its output before `return` — runtime activity failure on drift, not a silent bad-artefact propagation.
- Fixture unit tests: `schema.parse(validFixture)` succeeds, `schema.parse(invalidFixture)` throws. The same fixtures are reused by later agent-changes and eval suites.
- Scope boundary: **only contracts between activities.** Claude SDK prompt schemas, provenance hashing, persistence row types (already in `data-model`) are out of scope.

## Capabilities

### New Capabilities

- `agent-io-contracts`: a single registry of Zod schemas and inferred TS types for every inter-agent boundary of the pipeline, with mandatory runtime validation at the input and output of each phase activity.

### Modified Capabilities

- `ticket-workflow` (from `per-ticket-workflow`): signatures of the phase activities (`runSpecPhase`, `runCoderPhase`, `runReviewPhase`) become typed as `SpecPhaseOutput | CoderPhaseOutput | ReviewerVote[]` instead of `any`/`void`. The no-op implementations return placeholder values that are valid against the corresponding schemas.

## Impact

- New dep: `zod` (~50kb, zero peer deps, serialises cleanly through the Temporal JSON payload converter).
- New files: `server/src/agents/contracts/{spec-output,coder-output,reviewer-io,aggregator-io,shared,index}.ts`, plus `server/tests/agents/contracts/*.test.ts`.
- Depends on: `foundation` (server scaffold, tsconfig, vitest setup), `data-model` (row types — to draw a clear storage-vs-wire boundary).
- Depended on by (each adds a line to its own `Depends on` during implementation): `per-ticket-workflow`, `spec-agent`, `coder-agent`, `persona-reviewers`, `vote-aggregator`.
- Roadmap: lands in Phase 2 between `linear-integration` and `per-ticket-workflow` so the phase no-op activities carry typed signatures from day one and never need a refactor pass when real agents plug in.
- Non-goals: Claude SDK prompt format, provenance hashing, schema versioning (YAGNI — one current set), separate files under `openspec/specs/` (kept symmetric with the other open changes, which stop at proposals).
