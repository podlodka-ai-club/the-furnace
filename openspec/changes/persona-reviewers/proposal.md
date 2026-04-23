## Why

Concept §3.2: a single reviewer agent with a comprehensive prompt suffers context-window bias; independent contexts yield independent signals. Critically, persona disagreement becomes the scaling signal for human attention — without multiple personas there is no automated way to allocate scarce human review.

## What Changes

- Add four reviewer activities, each a Claude Agent SDK call with an independent context and a narrowly scoped prompt:
  - `reviewSecurityHawk`
  - `reviewPerfParanoid`
  - `reviewGrumpyArchitect`
  - `reviewNamingPatterns`
- Each receives the same input: green tests + diff + ticket metadata.
- Each produces the same output shape: `{ vote: "approve" | "reject", reasoning: string, flags: string[] }`.
- Activities run in parallel within the review phase and are rate-limited together to prevent subscription starvation.
- Each vote is persisted to the `reviews` table for later aggregation and audit.

## Capabilities

### New Capabilities

- `multi-persona-review`: Four narrow-mandate reviewer agents executing in parallel with independent Claude SDK contexts and a uniform vote schema.

### Modified Capabilities

- `ticket-workflow`: `runReviewPhase` now fans out to four parallel reviewer activities and gathers their votes.

## Impact

- Depends on: `coder-agent` (output diff shape), `container-as-worker`, `data-model` (`reviews` table).
- New files: `server/src/agents/reviewers/{security-hawk,perf-paranoid,grumpy-architect,naming-patterns}.ts` and matching `prompt.md` files.
- Parallelism amplifies subscription pressure — rate-limit config from `temporal-setup` must group these activities on a shared permit budget.
