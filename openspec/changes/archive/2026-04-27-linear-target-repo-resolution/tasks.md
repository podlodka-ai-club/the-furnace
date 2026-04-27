## 1. Types

- [x] 1.1 In `server/src/linear/types.ts`, drop `targetRepoSlug?: string` from `Ticket`; introduce `ResolvedTicket` extending the raw fields with `targetRepoSlug: string` (required).
- [x] 1.2 Update `LinearClientApi.listAgentReadyTickets` return type to `Promise<ResolvedTicket[]>`.
- [x] 1.3 Update `Ticket` consumers across `server/src/temporal/` to take `ResolvedTicket` where `targetRepoSlug` is read; verify the codebase compiles.

## 2. GraphQL query expansion

- [x] 2.1 Find the `listAgentReadyTickets` GraphQL query (currently in `server/src/linear/client.ts` or a sibling queries file) and add `name` to the labels selection alongside the existing `id`.
- [x] 2.2 Update the response type (`ListAgentReadyTicketsResponse` or equivalent) so each label node carries `{ id: string; name: string }`.

## 3. Slug resolver

- [x] 3.1 Add a pure helper `resolveRepoSlugFromLabels(labels: Array<{ name: string }>, registry: Set<string>)` that returns either `{ ok: true; slug }` or `{ ok: false; reason: "missing_repo_label" | "ambiguous_repo_label" | "unknown_repo_slug"; offending?: string }`.
- [x] 3.2 Implement the `repo:<slug>` parsing rule from the spec: exact prefix match, case-sensitive, no whitespace tolerance.
- [x] 3.3 Unit-test the resolver with: zero labels, one matching label, one matching unknown-slug label, multiple `repo:` labels, mixed case (`Repo:`), label with whitespace (`repo: foo`), unrelated labels only.

## 4. Repo registry access in the Linear client

- [x] 4.1 Decide and document where the registry comes from in the client path (`build/repos.json` loaded once, passed in via `createLinearClient` options, or read via `loadRepoSlugRegistry` from `server/src/temporal/repo-registry.ts`).
- [x] 4.2 Wire the chosen source into `createLinearClient` so `listAgentReadyTickets` has the registry available without re-reading the file on every call.

## 5. listAgentReadyTickets integration

- [x] 5.1 In `server/src/linear/client.ts:listAgentReadyTickets`, after each page maps to internal Ticket shape, call the resolver per ticket using the label `name` data from step 2.
- [x] 5.2 For resolved tickets, populate `targetRepoSlug` and include them in the returned array as `ResolvedTicket`.
- [x] 5.3 For unresolved tickets, exclude from the array and emit a structured log entry with shape `{ event: "linear.ticket_skipped", ticketId, identifier, reason, offendingSlug? }`.
- [x] 5.4 Ensure pagination still works exactly as before — exclusion happens after the per-page mapping, and a fully-skipped page does not stop traversal.

## 6. Workflow integration cleanup

- [x] 6.1 In `server/src/temporal/workflows/linear-poller.ts:45`, drop the `?? ""` fallback now that the type guarantees presence.
- [x] 6.2 Confirm the per-ticket workflow's empty-string check at `per-ticket.ts:95-100` becomes dead code at the producer side; keep it as defense-in-depth but note in a comment that the Linear client now guarantees non-empty.
- [x] 6.3 Confirm `validateRepoSlug` activity stays in place and unchanged.

## 7. Integration tests

- [x] 7.1 Add `server/tests/integration/linear-target-repo-resolution.test.ts` (or extend an existing file) that stubs Linear's HTTP boundary with a payload including labels `[{ id, name: "agent-ready" }, { id, name: "repo:<TEST_REPO_SLUG>" }]`.
- [x] 7.2 Run the linear-poller workflow against an in-process Temporal test environment with a mocked `launchWorkerContainer` activity.
- [x] 7.3 Assert that `launchWorkerContainer` is invoked once per phase with `repoSlug: TEST_REPO_SLUG`, and that no test code passes `targetRepoSlug` directly into any workflow input.
- [x] 7.4 Add negative coverage for `missing_repo_label`, `ambiguous_repo_label`, and `unknown_repo_slug` — assert `started: 0`, no `launchWorkerContainer` invocation, and a captured log entry with the expected reason.
- [x] 7.5 Add a mixed-batch test: one resolvable ticket + one ambiguous ticket → exactly one per-ticket workflow runs and one log entry is emitted.

## 8. Wire-shape test update

- [x] 8.1 Update `server/tests/integration/linear.test.ts` to assert the GraphQL `listAgentReadyTickets` query payload includes `name` in the labels selection.
- [x] 8.2 Update its response stubs to provide label `name` so existing happy-path mappings continue to pass.

## 9. Operator documentation

- [x] 9.1 Add a short note to `openspec/concept.md` (or wherever operator-facing onboarding lives) stating: "Tickets must carry both `agent-ready` and exactly one `repo:<slug>` label whose slug matches `build/repos.json`. Tickets without a valid repo label are logged and skipped."
- [x] 9.2 Update CLAUDE.md if it references the Linear → workflow path so future agents know about the label requirement.

## 10. Verification

- [x] 10.1 `npm test` passes (server unit + integration, devcontainer-image-build).
- [x] 10.2 `npm run typecheck` passes from repo root.
- [x] 10.3 Manually run `server/scripts/test-container-as-worker-e2e.ts` to confirm the e2e helper still works (it uses its own mocked `listAgentReadyTicketsActivity` returning `[]`, so the change should be transparent — but verify).
- [x] 10.4 `openspec validate linear-target-repo-resolution --strict` passes.
