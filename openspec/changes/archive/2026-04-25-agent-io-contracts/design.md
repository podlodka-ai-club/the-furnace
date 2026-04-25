## Context

The Phase 2 pipeline passes payloads across independent activities (spec, coder, reviewer) and currently describes those payloads in prose. This creates drift risk: each activity can evolve its own shape and silently break downstream phases. The change introduces a single Zod-backed contract registry for all inter-agent boundaries so payload drift fails immediately at activity boundaries.

Constraints:
- Keep scope to inter-activity wire contracts only.
- Fit existing server TypeScript structure and test tooling.
- Keep placeholder/no-op phase implementations valid against contracts so later changes can plug in without signature refactors.

## Goals / Non-Goals

**Goals:**
- Define one canonical schema module for spec -> coder -> reviewer boundaries.
- Export runtime schemas and inferred TypeScript types from the same source.
- Enforce input and output validation at activity boundaries.
- Add fixture-based contract tests for valid and invalid payloads.

**Non-Goals:**
- Defining Claude SDK prompt payload schemas.
- Changing persistence row types or provenance hashing formats.
- Introducing schema version negotiation or backward compatibility layers.

## Decisions

1. **Centralized contracts module under `server/src/agents/contracts/`**
   - Keep one file per boundary (`spec-output.ts`, `coder-output.ts`, `reviewer-io.ts`) and shared primitives in `shared.ts`.
   - Rationale: clear ownership boundaries while preserving shared primitives and avoiding circular definitions.
   - Alternative considered: one monolithic contracts file. Rejected because boundary-specific evolution and review become harder.

2. **Zod as single runtime + type source**
   - Define each contract as a Zod schema and export `z.infer` types.
   - Rationale: prevents divergence between runtime validation and static typing.
   - Alternative considered: TypeScript interfaces + custom runtime guards. Rejected due to duplicate maintenance and weaker composability.

3. **Fail-fast validation at phase borders**
   - Each phase activity validates on entry and before return (`schema.parse`).
   - Rationale: catches drift where it originates and avoids propagating malformed artifacts.
   - Alternative considered: validate only at workflow orchestration layer. Rejected because errors would be delayed and less actionable.

4. **Contract fixtures in tests reused by future agent changes**
   - Add positive and negative fixtures per schema in `server/tests/agents/contracts/`.
   - Rationale: creates reusable canonical examples and keeps later changes aligned.

## Risks / Trade-offs

- **[Schema strictness blocks in-progress phases]** -> Mitigation: keep placeholder outputs minimal but valid; update fixtures with each intentional contract change.
- **[Contract growth causes noisy coupling]** -> Mitigation: isolate shared primitives and keep boundary-specific fields local.
- **[Future capability additions (persona reviewers) need incompatible shapes]** -> Mitigation: defer to Phase 6 changes and add distinct contract extensions then.

## Migration Plan

1. Add `zod` dependency.
2. Add contracts module and exports.
3. Add fixture tests for each contract.
4. Update no-op phase activity signatures/returns to use inferred contract types and pass validation.
5. Run test suite to confirm contract and workflow typing changes are stable.

Rollback strategy:
- Revert contract module and activity signature updates as one unit if runtime validation causes regressions.
- Keep dependency rollback bundled in the same revert commit to restore pre-contract behavior.

## Open Questions

- Should escalation ticket references be modeled as a tagged union by escalation type now, or stay as a common `SubTicketRef` until real agents land?
- Should reviewer findings remain `string[]` for MVP, or move to structured findings in a later change?
