## Why

The `container-as-worker` change introduced `targetRepoSlug` as a required input to the per-ticket workflow, but no producer populates it. The Linear client returns tickets without that field set, so the poller passes `targetRepoSlug ?? ""` and the workflow fails fast with `InvalidWorkflowInput` before any container is launched. Today, only integration tests and the E2E helper work — they inject the slug directly. The end-to-end Linear → container path is broken in production.

## What Changes

- Define an operator-visible mechanism on Linear tickets that declares which target repo the ticket maps to (label-based, matched against `build/repos.json`).
- Extend the Linear client's `listAgentReadyTickets` to resolve that signal into `targetRepoSlug` and surface unresolved/conflicting cases as actionable failures, not silent empty values.
- Make `Ticket.targetRepoSlug` non-optional once resolved (refined "ready-to-run" type) so the workflow input boundary is statically enforced.
- Cover the full Linear → poller → per-ticket → `launchWorkerContainer` path in an integration test driven by a real-shaped ticket payload (no direct slug injection).
- **BREAKING**: Tickets that lack a resolvable repo signal will be skipped with a logged reason instead of starting a workflow that immediately fails — different observable behavior than today's silent fail-fast.

## Capabilities

### New Capabilities
<!-- None — this change extends an existing capability. -->

### Modified Capabilities
- `linear-client`: gains a Requirement that `listAgentReadyTickets` resolve a target-repo signal from the Linear ticket and either return the ticket with `targetRepoSlug` populated or skip/raise with a clear reason. Adds collision and unknown-slug handling at the Linear-side boundary.

## Impact

- Code:
  - `server/src/linear/client.ts` — `listAgentReadyTickets` mapping reads label data and resolves to a slug; pagination/query may need to fetch label names (currently only `labelIds` are read).
  - `server/src/linear/types.ts` — split `Ticket` (raw) from a refined "resolved" ticket type with `targetRepoSlug: string`.
  - `server/src/temporal/workflows/linear-poller.ts` — drop the `?? ""` fallback; rely on resolved type.
  - `server/src/linear/queries.ts` (or equivalent GraphQL) — request label `name` alongside `id`.
  - Tests: new integration test covering Linear payload → workflow → `launchWorkerContainer` invocation count, plus negative cases for missing/conflicting/unknown slugs.
- Dependencies: none new.
- Operator surface: tickets must carry a repo-identifying Linear label (exact convention to be locked in design.md). Existing tickets without such a label will be skipped instead of producing failed workflow runs.
- No changes to `container-worker-lifecycle`, `orchestration-substrate`, or `devcontainer-image-build` specs.
