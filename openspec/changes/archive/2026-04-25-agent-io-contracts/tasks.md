## 1. Contract Foundations

- [x] 1.1 Add `zod` to server dependencies and ensure it is available in build/test workflows.
- [x] 1.2 Create `server/src/agents/contracts/shared.ts` with shared schemas/types (`SubTicketRef`, `DiffStat`, `TestRunSummary`).
- [x] 1.3 Create boundary schema modules (`spec-output.ts`, `coder-output.ts`, `reviewer-io.ts`) with runtime schemas and `z.infer` type exports.
- [x] 1.4 Create `server/src/agents/contracts/index.ts` that re-exports all contract schemas and inferred types.

## 2. Workflow Integration

- [x] 2.1 Update phase activity input/output typing to use canonical contract types.
- [x] 2.2 Add input `schema.parse()` validation at each phase activity boundary.
- [x] 2.3 Add output `schema.parse()` validation before each phase activity returns.
- [x] 2.4 Ensure no-op phase implementations return placeholder payloads that satisfy their contracts.

## 3. Contract Tests and Fixtures

- [x] 3.1 Add fixture sets for each contract in `server/tests/agents/contracts/` (valid and invalid examples).
- [x] 3.2 Add fixture-based tests verifying valid fixtures parse and invalid fixtures throw for every contract.
- [x] 3.3 Run `npm test` and resolve any typing/validation regressions introduced by the new contracts.
