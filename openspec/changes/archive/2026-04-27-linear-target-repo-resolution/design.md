## Context

`container-as-worker` made `targetRepoSlug` a required field on the per-ticket workflow input. The slug must match an entry in `build/repos.json` and is used everywhere downstream (per-repo task queue `repo-${slug}-worker`, container env `WORKER_REPO`, manifest lookup at `build/${slug}/manifest.json`).

Today the producer side is missing. `Ticket.targetRepoSlug` is typed `?: string`; `listAgentReadyTickets` ([server/src/linear/client.ts:131-168](server/src/linear/client.ts#L131-L168)) only reads `id/identifier/title/priority/labelIds` and returns nothing else. The Linear-poller workflow falls back to `targetRepoSlug ?? ""` and the per-ticket workflow throws `InvalidWorkflowInput` before any container launch. End result: production runs are dead at the first real ticket; only injected-slug tests work.

The `linear-integration` change closed before `container-as-worker` was even proposed, which is why this gap exists.

## Goals / Non-Goals

**Goals:**
- Make a real Linear ticket flow through `listAgentReadyTickets → linear-poller → per-ticket → launchWorkerContainer` end-to-end without test-time slug injection.
- Keep the resolution logic at the Linear-client boundary so the workflow input contract stays exactly as `container-as-worker` defined it.
- Treat unresolvable tickets as a visible operator error, not a silent workflow-level fail-fast.
- Tighten the type system so an unresolved ticket cannot reach the workflow.

**Non-Goals:**
- Changing any container-side behavior, queue naming, or manifest contract.
- Changing the per-ticket workflow's existing `validateRepoSlug` activity — it stays as a defense-in-depth check.
- Building a UI or Linear admin tooling for managing the repo→label mapping (operators add labels in Linear's UI manually).
- Multi-repo tickets (one ticket → many repos). Out of scope; one ticket targets exactly one repo.

## Decisions

### Decision 1: Repo signal lives on a Linear label, not a custom field or description block

We will encode the target repo as a Linear label of the form `repo:<slug>` where `<slug>` matches an entry in `build/repos.json`.

**Why labels:**
- The existing GraphQL query already returns `labelIds`; expanding it to fetch label `name` is a one-field change. No new Linear API surface, no new permissions.
- Labels are visible in every Linear view, easy for an operator to add when triaging, and trivially filterable in Linear's own UI.
- The pattern is consistent with the existing `agent-ready` label that already gates ticket discovery.

**Alternatives considered:**
- *Linear custom fields*: workspace-admin scoped, harder to bootstrap in a fresh workspace, and requires extra API surface.
- *YAML/JSON block in description*: brittle (description is freeform, easy to break with edits), invisible until the ticket is opened, and adds a parser that needs its own error handling.

**Trade-off:** label names are mutable and not enforced against `build/repos.json` by Linear. We rely on runtime validation at the client boundary (see Decision 3).

### Decision 2: Resolution happens at the Linear-client boundary, not in the workflow

The `listAgentReadyTickets` method becomes the single point that translates Linear data into a workflow-ready ticket. Tickets without a resolvable repo signal are excluded from the returned list.

**Why here:**
- Keeps the workflow input contract from `container-as-worker` unchanged: a ticket arriving at the per-ticket workflow always has a non-empty, registry-known slug.
- Lets us split the type cleanly (see Decision 4) so unresolved tickets cannot accidentally be passed downstream.
- Preserves `validateRepoSlug` in the per-ticket workflow as a defense-in-depth check for any future producer (e.g., a manual workflow trigger) that might bypass the client.

**Alternative considered:** resolve in the linear-poller workflow. Rejected because (a) workflow code becomes responsible for label parsing, which couples it to Linear's data model, and (b) the failure mode "ticket exists but no repo label" surfaces in Temporal as workflow failures rather than operator-visible polling-side telemetry.

### Decision 3: Unresolvable tickets are skipped with a logged reason, not started-then-failed

When `listAgentReadyTickets` encounters an `agent-ready` ticket that:

- has no `repo:<slug>` label, OR
- has multiple `repo:<slug>` labels, OR
- has a `repo:<slug>` label whose slug is not in `build/repos.json`

…the client SHALL exclude that ticket from the returned list and emit a structured log entry naming the ticket identifier and the specific reason.

**Why skip rather than fail-the-workflow:**
- Today's behavior produces a doomed Temporal workflow run for every malformed ticket — noise in Temporal UI, churn in our workflow-runs table, and per-ticket-workflow's `WorkflowIdReusePolicy.REJECT_DUPLICATE` blocks the slot from any future correct attempt without manual cleanup.
- Skipping is reversible: the operator fixes the label, and the next poll cycle picks the ticket up cleanly.
- A logged reason is enough operator feedback for MVP. Posting a comment back to the Linear ticket is a future enhancement (see Open Questions).

**Why not just throw and stop the whole poll cycle:** one bad ticket should not block other valid tickets in the same poll batch.

**Trade-off:** an operator who never reads logs may not notice their ticket is being skipped. Mitigation: the `linear-poller` workflow's existing return value (`{ discovered, started, skipped }`) already exposes a skip count; we extend the log message to make the reason discoverable, and we'll consider a Linear comment in a follow-up.

### Decision 4: `Ticket` splits into raw vs resolved types

Today `Ticket.targetRepoSlug?: string` lets unresolved tickets propagate. We will introduce two types:

- `Ticket` (raw, internal to the Linear client): `targetRepoSlug` not present.
- `ResolvedTicket` (exported, used everywhere downstream): `targetRepoSlug: string` (required).

`listAgentReadyTickets` returns `ResolvedTicket[]`. The poller-workflow signature and per-ticket workflow input both consume `ResolvedTicket`. The `?? ""` fallback in [linear-poller.ts:45](server/src/temporal/workflows/linear-poller.ts#L45) goes away.

**Why:** static enforcement at the boundary means the workflow can drop its empty-string defensive check (it stays for slugs unknown to the registry, but no longer for empty strings). This is the kind of compiler-enforced invariant we should keep.

**Trade-off:** small breaking change to existing internal type. No external consumers, so the migration is local.

### Decision 5: Integration test exercises the real shape, not injected slugs

The new integration test SHALL:

- Stub Linear's HTTP boundary to return a ticket payload that includes both `agent-ready` and `repo:<TEST_REPO_SLUG>` labels (with the GraphQL `name` field populated).
- Run `listAgentReadyTickets` → linear-poller workflow → per-ticket workflow against an in-process Temporal test environment.
- Assert that `launchWorkerContainer` was invoked exactly 3 times (spec/coder/review) with `repoSlug: TEST_REPO_SLUG`.
- Cover negative cases: missing `repo:` label, multiple `repo:` labels, unknown slug. Each must result in zero workflow starts and a logged skip reason.

**Why:** the existing tests at [container-lifecycle.test.ts:157](server/tests/integration/container-lifecycle.test.ts#L157) and [temporal.ticketWorkflows.test.ts:51](server/tests/integration/temporal.ticketWorkflows.test.ts#L51) inject `targetRepoSlug` directly. They prove the workflow side works in isolation but cannot catch regressions in the resolution layer. We need the full path covered.

## Risks / Trade-offs

- **[Operator forgets the label]** → ticket is silently skipped. Mitigation: structured log entry with ticket identifier + reason; `linear-poller` already returns a `skipped` count. Follow-up: post a Linear comment back on skip.
- **[Slug typo in label]** → ticket is skipped as "unknown slug." Mitigation: error message names the offending value and the path to `build/repos.json`. Same recovery as above.
- **[Operator adds two `repo:` labels]** → ticket is skipped as "ambiguous repo target." Mitigation: same.
- **[GraphQL field expansion fails to deploy]** → if we forget to add `name` to the labels selection, every ticket is skipped because no label string ever resolves. Mitigation: integration test fails immediately because the happy-path stub depends on `name`.
- **[Race: label added after poll]** → poller skips the ticket; next poll cycle (cron-driven) picks it up. No durable bad state.

## Open Questions

- Should we post a Linear comment when a ticket is skipped, or rely on logs alone? Defer to operator feedback after first prod run; pencil this in as a separate change if logs prove insufficient.
- Do we need to filter out the `repo:` label prefix when persisting `labelIds` to the workflow run record, or is the raw set fine? Lean toward keeping the raw set — `labelIds` is a debugging breadcrumb, not a control surface.
