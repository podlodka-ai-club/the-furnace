# Autonomous Coding Agent System — Concept

## 1. Thesis

**The architecture's job is to turn failure modes into non-problems by definition, not to solve them with more engineering.**

A conventional autonomous coding agent handles bad state, stale sandboxes, rate-limit cascades, flaky review signals, and lost provenance by adding checks, retries, and observability on top. This concept takes the opposite stance: design each component so the corresponding failure class *cannot be expressed*, not *detected and recovered from*.

Every design choice below is justified against a simpler alternative. Each survives because it eliminates a failure class rather than mitigating it.

---

## 2. System Shape

### Pipeline

```
Linear (polled)
      │
      ▼
  Spec Agent ──(failing tests)──►  Coder Agent ──(green tests + diff)──►  Persona Reviewers (×4)
      │                                  │                                         │
      │                                  │                                         ▼
      ▼                                  ▼                              Vote Aggregator
  Clarification                    Sub-ticket                                    │
  sub-ticket                     (if stuck)                ┌─────────────────────┴─────────────────────┐
  (if ambiguous)                                           │                                           │
                                                  Unanimous pass                              Split vote
                                                           │                                           │
                                                           ▼                                           ▼
                                              Auto-merge + veto window                  Human tiebreaker
                                                  (Slack alert)                           in Linear
                                                           │
                                                           ▼
                                                    GitHub PR merged
```

### Orchestration

One **Temporal workflow per Linear ticket**. Each pipeline phase is a phase-level Temporal activity. Temporal gives us durability across worker restarts, signals for human approval and cancellation, deterministic replay for debugging, queryable state for "what is this workflow doing right now?", and **activity-level rate limiting** that keeps concurrent Claude SDK calls from starving our single subscription.

A separate **Temporal cron workflow** polls Linear on a schedule for tickets labeled `agent-ready` and enqueues a new per-ticket workflow for each. Pull model, not webhooks — no public endpoint, no webhook secret management.

### Execution substrate

**Ephemeral devcontainers as Temporal workers.** A container boots, registers itself with Temporal with capability metadata (languages, tools, repo it's specialized for), claims a matching task, executes, and dies. Worker lifecycle and sandbox lifecycle are the same event. Cleanup is a free side-effect of task completion.

Pre-warmed per-repo images carry the repo already cloned with dependencies installed, so cold-start is sub-second. CI rebuilds images on main commits.

**Ephemeral per *attempt*, not per ticket:** every failed reasoning attempt tears down its container; the next attempt starts from a clean pre-warmed state. No half-applied diffs, no cached builds, no rogue processes to contaminate replay.

### Authentication

Claude Agent SDK authenticated via **subscription key** (not API billing). Host `~/.claude` directory is mounted read-only into each container; the whole agent system shares one subscription.

**Implication:** the scarce resource is subscription concurrency/quota, not dollars. Temporal activity-level rate limiting prevents the system from starving itself when 4 personas, a spec agent, and a coder are running in parallel.

### Components

| Component | Responsibility |
|---|---|
| **Linear poller** | Temporal cron workflow polls Linear for `agent-ready` tickets; enqueues per-ticket workflow |
| **Spec agent** | Ticket → failing tests. Opens a clarification sub-ticket if AC is ambiguous |
| **Coder agent** | Makes the failing tests green inside the ephemeral devcontainer |
| **Persona reviewers** | Four reviewer agents with independent contexts: security hawk / perf paranoid / grumpy architect / naming & patterns |
| **Vote aggregator** | Unanimous pass → auto-merge queue with veto window. Split vote → human tiebreaker in Linear with each persona's reasoning |
| **GitHub adapter** | Opens PR, applies structured provenance trailers, auto-merges when veto window closes |
| **Container runtime** | Pre-warmed devcontainer images per repo; containers register as Temporal workers on boot |
| **Provenance store** | Content-addressed tool outputs, structured commit trailers (workflow-id, model, ticket, attempt-count) |

---

## 3. Design Principles

Six load-bearing architectural claims. Each was stress-tested against the strongest simpler alternative. Each survives because it collapses a failure class to impossibility by construction.

### 3.1 Durable orchestration (Temporal, not a script + queue)

A script with retries and a queue replicates none of: surviving worker crashes mid-workflow, signals as a first-class primitive for human approval/cancellation, deterministic replay for time-travel debugging, or queryable in-flight state.

LangGraph is for in-memory agent graphs; we're building *workflows that happen to use agents*. BullMQ and similar queues reinvent pieces of Temporal badly.

Under the subscription-auth constraint, Temporal's activity-level rate limiting and retry/backoff are additionally load-bearing — without them, concurrent Claude SDK calls cascade into self-starvation.

**Principle:** *Durable, signal-driven orchestration with queryable state is purpose-built-for, not reinvented.*

### 3.2 Multi-persona review (not one reviewer agent)

A single reviewer agent with a comprehensive prompt suffers context-window bias: security, performance, naming, and architecture concerns compete for attention in one reasoning pass. Independent contexts yield independent signals.

Critically, **persona disagreement becomes the escalation signal**. Unanimous pass is safe to auto-merge; split vote is a cheap "this one needs a human" filter. Without multiple personas, there is no automated way to allocate scarce human review attention.

**Principle:** *Narrow-mandate agents outperform sprawling-mandate agents; their disagreement is the scaling signal for human attention.*

### 3.3 Container-as-worker (not a long-lived worker pool)

A long-lived worker pool accumulates state across tasks — partial diffs, cached builds, rogue processes, filesystem drift — which corrupts replay and causes noisy-neighbor failures. Collapsing worker lifecycle and sandbox lifecycle into a single event makes cleanup a free side-effect of task completion.

Capability self-registration falls out for free: new worker types are deployed by pushing images, with zero orchestrator code changes.

**Principle:** *Co-locating worker lifecycle with sandbox lifecycle eliminates a whole category of state-management bugs by definition.*

### 3.4 Spec-agent-writes-tests-first (not coder writes its own)

When the coder writes its own tests, it can tune them — consciously or not — to pass its own implementation. Tests then validate intent rather than requirements. Splitting specification from implementation into two independent reasoning passes, with tests as the hard artifact interface, prevents this.

If the spec agent *cannot* translate a ticket into tests, that is itself a first-class signal: the ticket is ambiguous, and a clarification sub-ticket is opened before any coding work begins.

**Principle:** *Separating specification from implementation into two reasoning passes, with tests as the artifact interface, prevents the model from tuning tests to its own output.*

### 3.5 Devcontainer spec (not a bespoke Dockerfile)

If the repo already has a `devcontainer.json`, it is the environment specification humans already use. An agent running a different environment creates a "works for humans, fails in agent container" failure class and forces maintenance of two parallel environments.

Using the same spec means: compose services (postgres, redis) for free, future human takeover via `code tunnel`, and zero environment drift. Firecracker or equivalent hardware isolation is overkill — we're running code we trust enough to open PRs from.

**Principle:** *The development environment is already specified. Agents should use the exact same spec humans use, not a parallel one that drifts.*

### 3.6 Ephemeral per attempt (not per ticket)

Per-ticket containers accumulate residue from failed attempts: half-applied diffs, test artifacts, process ghosts, cached builds. "Why did attempt 2 behave differently given the same prompt?" becomes an unsolvable mystery. Per-attempt ephemerality turns it into a non-question.

**Principle:** *Clean state between attempts is cheaper than debugging state drift.*

### Meta-principle

Each of the six principles has the same shape: *by construction, X becomes a non-problem.* The architecture exists to turn failure modes into impossibilities, not to layer in recovery logic.

---

## 4. MVP Build

What ships by demo day. A real, coherent system — not a demo slice.

- Temporal cron workflow polls Linear for `agent-ready` tickets
- Per-ticket Temporal workflow with three phase-level activities: spec → code → review
- Container-as-worker with capability self-registration: image boots → announces capabilities → claims matching task → dies
- Pre-warmed devcontainer image for 1–2 demo repos
- Spec agent: Linear ticket → failing tests; opens typed clarification sub-ticket if AC ambiguous
- Coder agent: Claude Agent SDK loop inside container; goal is tests green
- Four tuned personas: security hawk / perf paranoid / grumpy architect / naming & patterns
- Vote aggregator with auto-merge on unanimous consensus + veto window (Slack notification)
- Agent files its own Linear sub-tickets when stuck, typed by reason (`ac-clarification`, `dep-missing`, `design-question`) with deep links to the stuck workflow moment
- Structured commit trailers (workflow-id, model, ticket, attempt-count) and content-addressed tool-output storage
- Live observability via Temporal's built-in UI (no custom dashboard)

### Top risks

1. **Temporal learning curve.** Budget day 1 for a trivial workflow to validate the mental model before committing architectural decisions.
2. **Container-as-worker lifecycle subtleties** — auth propagation, registration, graceful death, task-claim race conditions. Person 2 starts with no-op activities. Prove the lifecycle works before adding agent logic.
3. **Subscription rate-limit cascade.** Four personas + coder + spec agent running in parallel on one subscription can starve themselves. Mitigation: Temporal activity-level rate limiting from day 1, not bolted on later. Validate with a load test at end of week 1.
4. **Picking the right demo ticket.** Curate 5–10 candidates by end of week 1. Criteria: ≤100 LOC change, clear testable AC, no external service dependencies. Keep fallbacks ready.
5. **Live Claude SDK can fail on stage** (rate limits, network, demo gods). Pre-record a backup workflow run as screen-share insurance.

---

## 5. Roadmap (V1+)

Post-hackathon priorities, mostly P4-flavored production-readiness and observability:

- **Red-team adversarial persona** as a final pre-merge gate
- **Shadow-mode rollout gate** for onboarding new repos (PRs generated but not opened for N weeks)
- **OpenTelemetry spans per tool call** and a reasoning-quality SLO (e.g., "90% of PRs pass review on first attempt") as burn-rate metrics
- **Agent-owned feature flags** with post-merge metric watching and auto-revert
- **Retro-writing meta-agent** after every merge or abandon; agent files Linear tickets against itself when it keeps failing a task class
- **Rate-limit-aware model routing** — Haiku for trivial subtasks, Opus for hard ones — stretching subscription headroom
- **Split reasoning from execution** — Claude SDK on host (authenticated), container for sandboxed execution only
- **Fine-grained Temporal activities** (every tool call as an activity) if observability pain warrants it

---

## 6. Explicit Rejections

Considered, rejected for now, with reasoning:

- **Webhook receiver for Linear.** Pull model is simpler — no public endpoint, no webhook secrets. Latency cost is negligible for this workflow shape.
- **Multi-repo / cross-repo coordinated PRs.** Scope creep; single-repo demos the thesis fully.
- **Tool-call-level Temporal granularity (P2 personality).** Interesting replay properties, but plumbing would consume the sprint. Kept as a V1+ option if observability warrants it.
- **Debate topology / peer coder agents (P3 personality).** Demo-visibility appeal, but complexity outweighs payoff for first implementation.
- **Custom dashboard.** Temporal's built-in UI suffices; building bespoke visualization is Day-N polish.
- **Agent runs its own standups in Slack.** Theatrical but redundant with sub-ticket visibility.
- **Rewind button / parallel variance replay / two-agent pairing / rubber-duck pre-execution.** All interesting; all future work.

---

## 7. Reservoir

Ideas considered during concept development and kept alive as future-sprint options. Each is one small experiment away from being usable.

**Observability & trust:** OpenTelemetry spans per tool call · reasoning-quality SLO · "why did you do that?" query API on any commit · anomaly detection on agent behavior drift · sampled decision audit → human eval stream.

**Testing in prod:** agent-owned feature flags with auto-revert · chaos tests required per PR · synthetic-user simulation post-deploy · rollback as first-class workflow step · A/B tests for non-critical UI changes · deliberate intentional bugs quarterly to calibrate review apparatus.

**Cross-task learning:** retro-writing meta-agent · agent files tickets against itself · prompt/config self-improvement loop based on failure patterns.

**Trust rollout:** shadow-mode period per repo · one-click human takeover via `code tunnel` with context handoff · gradual autonomy promotion.

**Adversarial calibration:** 3x parallel replay measuring variance as a confidence signal · two-agent pairing (e.g., pessimist + architect) on hard tasks · rubber-duck agent that forces explicit plans before execution · learned task refusal (agent declines low-probability tasks upfront).