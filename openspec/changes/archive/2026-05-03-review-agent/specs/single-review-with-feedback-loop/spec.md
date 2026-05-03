## ADDED Requirements

### Requirement: Review Activity Runs On Per-Attempt Container Queue

The system SHALL register `runReviewAgent` as the implementation of `runReviewPhase` on the per-repo container task queue (the same dispatch as `runSpecPhase` and `runCoderPhase`). The reviewer SHALL operate against the in-container working tree on the spec phase's feature branch so it can read file contents around finding locations and run lightweight static checks.

#### Scenario: Reviewer registered on per-repo container worker

- **WHEN** a per-repo container worker boots
- **THEN** `runReviewPhase` MUST resolve to the real `runReviewAgent` implementation, not the no-op stub
- **AND** the activity MUST NOT be registered on the orchestrator worker

#### Scenario: Reviewer operates on the feature branch workspace

- **WHEN** the review activity begins
- **THEN** it MUST execute against the spec phase's feature branch checked out inside the container
- **AND** the agent MUST be able to read repo files via the SDK's `Read`, `Glob`, `Grep` tools

### Requirement: Reviewer Activity Drives Claude Agent SDK Inside Container

The review phase activity SHALL invoke the Claude Agent SDK from inside the per-ticket worker container, using the in-container working tree as the agent's filesystem and the bind-mounted `~/.claude` credentials for subscription auth.

#### Scenario: Activity loads prompt at runtime

- **WHEN** `runReviewAgent` body starts
- **THEN** the prompt file MUST be read via `fs.readFile` from `server/src/agents/review/prompt.md` at activity entry, not cached at module import time
- **AND** the SDK conversation MUST execute inside the container, not on the orchestrator host

### Requirement: Reviewer Returns Structured Verdict

The review activity SHALL return a `ReviewResult` of shape `{ verdict: "approve" | "changes_requested", reasoning: string, findings: Finding[] }` where `Finding` is `{ path: string; line?: number; severity: "blocking" | "advisory"; message: string }`. The output SHALL be validated via `reviewResultSchema.parse()` before return.

#### Scenario: Approve verdict carries no blocking findings

- **WHEN** the agent emits an `approve` verdict
- **THEN** the result MUST contain `verdict: "approve"`
- **AND** every finding present MUST have severity `advisory`

#### Scenario: Changes-requested verdict carries at least one blocking finding

- **WHEN** the agent emits a `changes_requested` verdict
- **THEN** the result MUST contain `verdict: "changes_requested"`
- **AND** at least one finding MUST be present with severity `blocking`

#### Scenario: Output validation enforced

- **WHEN** the activity is about to return
- **THEN** the value MUST pass `reviewResultSchema.parse()`
- **AND** if validation fails the activity MUST throw rather than return a malformed payload

### Requirement: Reviewer Receives Coder Output And PR Number As Input

The review activity input SHALL include the ticket reference, the coder phase's `featureBranch` and `finalCommitSha`, the coder phase's `diffStat` and `testSummary`, the open PR number, and the current round counter.

#### Scenario: Activity input carries upstream artifacts

- **WHEN** the workflow invokes `runReviewPhase`
- **THEN** the input MUST include `ticket`, `featureBranch`, `finalCommitSha`, `diffStat`, `testSummary`, `prNumber`, and `round`
- **AND** the input MUST pass the canonical reviewer input schema validation

### Requirement: Reviewer Prompt Includes PR Changed Paths

After checking out the feature branch and before starting the SDK conversation, the review activity SHALL compute the repo-relative paths changed in the PR diff and render them into the reviewer prompt. The path list SHALL be computed from the merge-base style diff between the target repo default branch and `HEAD`, equivalent to `git diff --name-only origin/<defaultBranch>...HEAD`.

#### Scenario: Changed paths rendered before SDK starts

- **WHEN** `runReviewAgent` has checked out the feature branch
- **THEN** it MUST resolve the target repo default branch from the local `origin` refs
- **AND** it MUST compute changed paths with `git diff --name-only origin/<defaultBranch>...HEAD`
- **AND** it MUST render those paths into the prompt before the SDK conversation starts

#### Scenario: Empty changed-path list is explicit

- **WHEN** the changed-path computation returns no paths
- **THEN** the prompt MUST include an explicit no-paths placeholder instead of silently omitting the section

### Requirement: Reviewer Findings Are Limited To PR Diff Paths

Structured `findings[]` entries SHALL cite only repo-relative paths that appear in the PR changed-path list supplied to the reviewer prompt. Concerns about files outside the PR diff, files that should have changed but did not, or broader architectural issues SHALL be described in `reasoning` rather than emitted as structured findings.

#### Scenario: Finding path appears in changed-path list

- **WHEN** the reviewer emits a `findings[]` entry
- **THEN** `finding.path` MUST exactly match one path from the changed-path prompt section
- **AND** the finding MAY include `line` only when that line is part of the PR diff for that file

#### Scenario: Off-diff concern captured in reasoning

- **WHEN** the reviewer identifies a concern about a file outside the changed-path list
- **THEN** the reviewer MUST describe that concern in `reasoning`
- **AND** it MUST NOT emit a structured `findings[]` entry for that off-diff file

### Requirement: Reviewer Trusts Coder-Reported Test Summary

The review activity SHALL receive the coder phase's test-run summary verbatim and SHALL NOT re-run the repo's test command. Re-running tests is out of scope; the coder activity already verifies green per `code-generation`.

#### Scenario: No re-run of test command

- **WHEN** the review activity executes
- **THEN** it MUST NOT invoke the repo's `package.json` test script
- **AND** it MUST consume `input.testSummary` as the source of truth for test pass/fail counts

### Requirement: Activity Heartbeats On Schedule

The review activity SHALL heartbeat at a cadence that fits within the workflow's `heartbeatTimeout` of 30 seconds, including during long-running SDK conversations, so cooperative cancellation is honored.

#### Scenario: Heartbeat at start

- **WHEN** the review activity begins
- **THEN** it MUST call `Context.heartbeat()` before invoking the SDK

#### Scenario: Heartbeat during SDK conversation

- **WHEN** the SDK conversation is in flight
- **THEN** the activity MUST heartbeat at least every 5 seconds via a `setInterval`
- **AND** the interval MUST be cleared in a `finally` block on activity exit
