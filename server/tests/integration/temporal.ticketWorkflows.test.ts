import { randomUUID } from "node:crypto";
import net from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import { ActivityFailure, ApplicationFailure } from "@temporalio/common";
import { WorkflowFailedError } from "@temporalio/client";
import {
  createPerRepoWorker,
  createTemporalWorker,
  type TemporalWorkerActivities,
} from "../../src/temporal/worker.js";
import { createTemporalClient } from "../../src/temporal/client.js";
import { TEMPORAL_TASK_QUEUE } from "../../src/temporal/config.js";
import { taskQueueForRepo } from "../../src/temporal/repo-slug.js";
import {
  LINEAR_POLLER_WORKFLOW_NAME,
} from "../../src/temporal/workflows/linear-poller.js";
import {
  buildPerTicketWorkflowId,
  cancelSignal,
  clarificationAnswerSignal,
  currentClarificationQuery,
  currentPhaseQuery,
  currentRoundQuery,
  PER_TICKET_WORKFLOW_NAME,
  PHASE_ATTEMPT_BUDGET_EXHAUSTED_FAILURE_TYPE,
  REVIEW_ROUND_CAP_EXHAUSTED_FAILURE_TYPE,
  attemptCountQuery,
} from "../../src/temporal/workflows/per-ticket.js";
import type { CoderPhaseInput, SpecPhaseInput } from "../../src/temporal/activities/phases.js";
import type { SpecPhaseOutput, SpecPhaseResult } from "../../src/agents/contracts/index.js";
import type { ReviewerInput } from "../../src/agents/contracts/index.js";

function specPhaseDone(output: SpecPhaseOutput): SpecPhaseResult {
  return { kind: "done", output };
}
import type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
} from "../../src/temporal/activities/worker-launcher.js";
import { installWorkflowCleanupHook } from "./helpers/workflow-cleanup.js";
import { validImplementationPlan } from "../agents/contracts/fixtures.js";

// Each test gets a unique slug (and therefore a unique per-repo task queue)
// so that pending activity tasks left over from prior test runs in the shared
// Temporal namespace cannot be claimed by a later test's worker. Without this,
// a leftover spec/coder task from a previous run pollutes phaseCalls and
// breaks deterministic phase-sequence assertions.
let TEST_REPO_SLUG: string;
let TEST_REPO_QUEUE: string;

describe("Temporal per-ticket workflow orchestration", () => {
  installWorkflowCleanupHook();

  beforeEach(() => {
    TEST_REPO_SLUG = `test-repo-${randomUUID()}`;
    TEST_REPO_QUEUE = taskQueueForRepo(TEST_REPO_SLUG);
  });


  it("poller starts ticket workflows idempotently by ticket ID", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `test-issue-${randomUUID()}`;
    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      listAgentReadyTicketsActivity: async () => [
        {
          id: ticketId,
          identifier: "ENG-1",
          title: "Agent-ready ticket",
          description: "",
          priority: 1,
          labelIds: ["agent-ready"],
          targetRepoSlug: TEST_REPO_SLUG,
        },
      ],
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });

    await worker.runUntil(async () => {
      const firstPoll = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
        args: [],
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowId: `test-poller-${randomUUID()}`,
      });

      const firstPollResult = await firstPoll.result();
      expect(firstPollResult.discovered).toBe(1);
      expect(firstPollResult.started + firstPollResult.skipped).toBe(1);

      const secondPoll = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
        args: [],
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowId: `test-poller-${randomUUID()}`,
      });

      const secondPollResult = await secondPoll.result();
      expect(secondPollResult.discovered).toBe(1);
      expect(secondPollResult.started + secondPollResult.skipped).toBe(1);
    });
  }, 30_000);

  it("keeps per-ticket workflow alive after poller completion", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `test-issue-${randomUUID()}`;
    const syncedStateNames: string[] = [];
    let releaseSpec: (() => void) | undefined;
    const specGate = new Promise<void>((resolve) => {
      releaseSpec = resolve;
    });

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        await specGate;
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: `Failing acceptance tests for ${input.ticket.identifier}`,
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "c".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      listAgentReadyTicketsActivity: async () => [
        {
          id: ticketId,
          identifier: "ENG-1",
          title: "Agent-ready ticket",
          description: "",
          priority: 1,
          labelIds: ["agent-ready"],
          targetRepoSlug: TEST_REPO_SLUG,
        },
      ],
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await Promise.all([
      worker.runUntil(async () => {
        await repoWorker.runUntil(async () => {
          const pollerHandle = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
            args: [],
            taskQueue: TEMPORAL_TASK_QUEUE,
            workflowId: `test-poller-${randomUUID()}`,
          });

          await expect(pollerHandle.result()).resolves.toEqual({
            discovered: 1,
            started: 1,
            skipped: 0,
          });

          const ticketHandle = client.workflow.getHandle(buildPerTicketWorkflowId(ticketId));
          await waitFor(async () => (await ticketHandle.query(currentPhaseQuery)) === "spec");

          releaseSpec?.();
          await expect(ticketHandle.result()).resolves.toEqual({
            status: "succeeded",
            pr: { number: 1, url: "https://github.test/example/pr/1" },
          });
        });
      }),
    ]);

    expect(syncedStateNames).toEqual(["In Progress", "Done"]);
  }, 30_000);

  it("runs phases in order, supports cancel signal, and answers queries", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const syncedStateNames: string[] = [];
    let prOpenCalls = 0;
    let releaseSpec: (() => void) | undefined;
    const specGate = new Promise<void>((resolve) => {
      releaseSpec = resolve;
    });

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        await specGate;
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: `Failing acceptance tests for ${input.ticket.identifier}`,
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => {
        phaseCalls.push("coder");
        return {
          featureBranch: input.specOutput.featureBranch,
          finalCommitSha: "d".repeat(40),
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
        };
      },
      runReviewPhase: async (_input: ReviewerInput) => {
        phaseCalls.push("review");
        return {
          verdict: "approve" as const,
          reasoning: "ok",
          findings: [],
        };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      listAgentReadyTicketsActivity: async () => [],
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
      openPullRequestActivity: async () => {
        prOpenCalls += 1;
        return { number: 1, url: "https://github.test/example/pr/1" };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_2",
                identifier: "ENG-2",
                title: "Cancelable ticket",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await waitFor(async () => (await handle.query(currentPhaseQuery)) === "spec");
        expect(await handle.query(attemptCountQuery)).toBe(1);

        await handle.signal(cancelSignal);
        releaseSpec?.();

        await expect(handle.result()).resolves.toEqual({ status: "cancelled" });
        expect(await handle.query(currentPhaseQuery)).toBe("cancelled");
        expect(await handle.query(attemptCountQuery)).toBe(1);
      });
    });

    expect(phaseCalls).toEqual(["spec"]);
    expect(syncedStateNames).toEqual(["In Progress", "Canceled"]);
    expect(prOpenCalls).toBe(0);
  }, 30_000);

  it("DepMissingRequested from coder phase: review NOT invoked, ticket stays In Progress, no PR opened", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const syncedStateNames: string[] = [];
    let prOpenCalls = 0;
    const subTicketRef = { id: "issue_dep", identifier: "ENG-DEP-1", title: "dep-missing for ENG-3" };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (_input: CoderPhaseInput) => {
        phaseCalls.push("coder");
        throw ApplicationFailure.nonRetryable(
          "Coder agent reported missing dependency: opened ENG-DEP-1",
          "DepMissingRequested",
          { subTicketRef },
        );
      },
      runReviewPhase: async (_input: ReviewerInput) => {
        phaseCalls.push("review");
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
      openPullRequestActivity: async () => {
        prOpenCalls += 1;
        return { number: 1, url: "https://github.test/example/pr/1" };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_3",
                identifier: "ENG-3",
                title: "Stuck on dep",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await assertStuckSubTicketRef(
          handle.result(),
          "DepMissingRequested",
          subTicketRef,
        );
      });
    });

    expect(phaseCalls).toEqual(["spec", "coder"]);
    expect(syncedStateNames).toEqual(["In Progress"]);
    expect(prOpenCalls).toBe(0);
  }, 30_000);

  it("DesignQuestionRequested from coder phase: review NOT invoked, ticket stays In Progress", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const syncedStateNames: string[] = [];
    const subTicketRef = { id: "issue_dq", identifier: "ENG-DQ-1", title: "design-question for ENG-4" };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (_input: CoderPhaseInput) => {
        phaseCalls.push("coder");
        throw ApplicationFailure.nonRetryable(
          "Coder agent reported design question: opened ENG-DQ-1",
          "DesignQuestionRequested",
          { subTicketRef },
        );
      },
      runReviewPhase: async (_input: ReviewerInput) => {
        phaseCalls.push("review");
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_4",
                identifier: "ENG-4",
                title: "Stuck on design",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await assertStuckSubTicketRef(
          handle.result(),
          "DesignQuestionRequested",
          subTicketRef,
        );
      });
    });

    expect(phaseCalls).toEqual(["spec", "coder"]);
    expect(syncedStateNames).toEqual(["In Progress"]);
  }, 30_000);

  it("happy coder result: review phase invoked with coder output and PR opened with workflow metadata", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const seenReviewerInputs: ReviewerInput[] = [];
    const seenPrInputs: Array<Record<string, unknown>> = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => {
        phaseCalls.push("coder");
        return {
          featureBranch: input.specOutput.featureBranch,
          finalCommitSha: "f".repeat(40),
          diffStat: { filesChanged: 2, insertions: 7, deletions: 1 },
          testRunSummary: { total: 4, passed: 4, failed: 0, durationMs: 42 },
        };
      },
      runReviewPhase: async (input: ReviewerInput) => {
        phaseCalls.push("review");
        seenReviewerInputs.push(input);
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      openPullRequestActivity: async (input) => {
        seenPrInputs.push(input as unknown as Record<string, unknown>);
        return { number: 1, url: "https://github.test/example/pr/1" };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_5",
                identifier: "ENG-5",
                title: "Happy path",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });
        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });
      });
    });

    expect(phaseCalls).toEqual(["spec", "coder", "review"]);
    expect(seenReviewerInputs).toHaveLength(1);
    expect(seenReviewerInputs[0].finalCommitSha).toBe("f".repeat(40));
    expect(seenReviewerInputs[0].diffStat).toEqual({ filesChanged: 2, insertions: 7, deletions: 1 });
    expect(seenReviewerInputs[0].testRunSummary.passed).toBe(4);
    expect(seenPrInputs).toHaveLength(1);
    expect(seenPrInputs[0]).toMatchObject({
      featureBranch: expect.stringContaining("agent/spec-eng-5"),
      targetRepoSlug: TEST_REPO_SLUG,
      finalCommitSha: "f".repeat(40),
      diffSummary: "2 files changed, +7/-1",
      attemptCount: expect.any(Number),
    });
  }, 30_000);

  it("generic non-stuck failure surfaces via normal Temporal failure semantics", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (_input: CoderPhaseInput) => {
        phaseCalls.push("coder");
        throw ApplicationFailure.nonRetryable(
          "synthesized push failure",
          "CoderPushFailed",
        );
      },
      runReviewPhase: async (_input: ReviewerInput) => {
        phaseCalls.push("review");
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_6",
                identifier: "ENG-6",
                title: "generic failure",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      });
    });

    expect(phaseCalls).toContain("coder");
    expect(phaseCalls).not.toContain("review");
  }, 30_000);

  it("review round 0 happy path: single openPR, single postReview with APPROVE, succeeded", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    let openPrCalls = 0;
    const postReviewCalls: Array<{
      verdict: string;
      prNumber: number;
      commentCount: number;
    }> = [];
    const reviewerInputs: ReviewerInput[] = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => specPhaseDone({
        featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
        testCommits: [
          {
            sha: "a".repeat(40),
            path: "server/tests/integration/sample.test.ts",
            description: "default",
          },
        ],
        implementationPlan: validImplementationPlan,
      }),
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (input: ReviewerInput) => {
        reviewerInputs.push(input);
        return {
          verdict: "approve" as const,
          reasoning: "All clean.",
          findings: [],
        };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      openPullRequestActivity: async () => {
        openPrCalls += 1;
        return { number: 42, url: "https://github.test/example/pr/42" };
      },
      postPullRequestReviewActivity: async (input) => {
        postReviewCalls.push({
          verdict: input.verdict,
          prNumber: input.prNumber,
          commentCount: input.comments.length,
        });
        return { reviewId: 1, droppedComments: 0 };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_round0",
                identifier: "ENG-100",
                title: "round 0 happy",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `ticket-test-${randomUUID()}`,
        });
        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 42, url: "https://github.test/example/pr/42" },
        });
      });
    });

    expect(openPrCalls).toBe(1);
    expect(postReviewCalls).toEqual([
      { verdict: "approve", prNumber: 42, commentCount: 0 },
    ]);
    expect(reviewerInputs).toHaveLength(1);
    expect(reviewerInputs[0].round).toBe(0);
    expect(reviewerInputs[0].prNumber).toBe(42);
  }, 30_000);

  it("review iterate path: round 0 changes_requested then round 1 approve, single openPR, two reviews", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    let openPrCalls = 0;
    const postReviewVerdicts: string[] = [];
    const reviewerInputs: ReviewerInput[] = [];
    const coderInputs: CoderPhaseInput[] = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => specPhaseDone({
        featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
        testCommits: [
          {
            sha: "a".repeat(40),
            path: "server/tests/integration/sample.test.ts",
            description: "default",
          },
        ],
        implementationPlan: validImplementationPlan,
      }),
      runCoderPhase: async (input: CoderPhaseInput) => {
        coderInputs.push(input);
        return {
          featureBranch: input.specOutput.featureBranch,
          finalCommitSha: input.priorReview ? "b".repeat(40) : "a".repeat(40),
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
        };
      },
      runReviewPhase: async (input: ReviewerInput) => {
        reviewerInputs.push(input);
        if (input.round === 0) {
          return {
            verdict: "changes_requested" as const,
            reasoning: "Needs work.",
            findings: [
              {
                path: "src/foo.ts",
                line: 12,
                severity: "blocking" as const,
                message: "Null check missing",
              },
            ],
          };
        }
        return {
          verdict: "approve" as const,
          reasoning: "Looks good now.",
          findings: [],
        };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      openPullRequestActivity: async () => {
        openPrCalls += 1;
        return { number: 50, url: "https://github.test/example/pr/50" };
      },
      postPullRequestReviewActivity: async (input) => {
        postReviewVerdicts.push(input.verdict);
        return { reviewId: postReviewVerdicts.length, droppedComments: 0 };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_iterate",
                identifier: "ENG-101",
                title: "iterate path",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `ticket-test-${randomUUID()}`,
        });
        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 50, url: "https://github.test/example/pr/50" },
        });
      });
    });

    expect(openPrCalls).toBe(1);
    expect(postReviewVerdicts).toEqual(["changes_requested", "approve"]);
    expect(reviewerInputs.map((r) => r.round)).toEqual([0, 1]);
    expect(coderInputs).toHaveLength(2);
    expect(coderInputs[0].priorReview).toBeUndefined();
    expect(coderInputs[1].priorReview).toBeDefined();
    expect(coderInputs[1].priorReview?.prNumber).toBe(50);
    expect(coderInputs[1].priorReview?.findings).toHaveLength(1);
    expect(coderInputs[1].priorReview?.findings[0].severity).toBe("blocking");
  }, 30_000);

  it("review cap exhaustion: maxReviewRounds=2, every round changes_requested, throws ReviewRoundCapExhausted, ticket stays In Progress", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    let openPrCalls = 0;
    const reviewRounds: number[] = [];
    const postReviewVerdicts: string[] = [];
    const syncedStateNames: string[] = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => specPhaseDone({
        featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
        testCommits: [
          {
            sha: "a".repeat(40),
            path: "server/tests/integration/sample.test.ts",
            description: "default",
          },
        ],
        implementationPlan: validImplementationPlan,
      }),
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: input.priorReview ? "b".repeat(40) : "a".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (input: ReviewerInput) => {
        reviewRounds.push(input.round);
        return {
          verdict: "changes_requested" as const,
          reasoning: `Round ${input.round} still needs work.`,
          findings: [
            {
              path: "src/foo.ts",
              severity: "blocking" as const,
              message: "Persistent issue",
            },
          ],
        };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
      openPullRequestActivity: async () => {
        openPrCalls += 1;
        return { number: 60, url: "https://github.test/example/pr/60" };
      },
      postPullRequestReviewActivity: async (input) => {
        postReviewVerdicts.push(input.verdict);
        return { reviewId: postReviewVerdicts.length, droppedComments: 0 };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_exhaust",
                identifier: "ENG-102",
                title: "cap exhaustion",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
              maxReviewRounds: 2,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `ticket-test-${randomUUID()}`,
        });

        const error = await handle.result().then(
          () => {
            throw new Error("expected workflow to fail with ReviewRoundCapExhausted");
          },
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(WorkflowFailedError);
        const cause = (error as WorkflowFailedError).cause;
        expect(cause).toBeInstanceOf(ApplicationFailure);
        const af = cause as ApplicationFailure;
        expect(af.type).toBe(REVIEW_ROUND_CAP_EXHAUSTED_FAILURE_TYPE);
        expect(af.nonRetryable).toBe(true);
        expect(af.details).toBeDefined();
        const detail = (af.details as unknown[])[0] as Record<string, unknown>;
        expect(detail.verdict).toBe("changes_requested");
        expect(detail.prNumber).toBe(60);
        expect(detail.findings).toBeDefined();

        expect(await handle.query(currentRoundQuery)).toBe(1);
      });
    });

    expect(openPrCalls).toBe(1);
    expect(reviewRounds).toEqual([0, 1]);
    expect(postReviewVerdicts).toEqual(["changes_requested", "changes_requested"]);
    // Linear ticket must remain In Progress on cap exhaustion (no transition to Done/Canceled).
    expect(syncedStateNames).toEqual(["In Progress"]);
  }, 30_000);

  it("cancel between rounds: cancel after first post → no further coder/review invocations, cancelled terminal state", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const reviewRounds: number[] = [];
    const coderInputs: CoderPhaseInput[] = [];
    let postReviewCalls = 0;
    let cancelSent = false;
    const syncedStateNames: string[] = [];
    let cancelHook: (() => Promise<void>) | undefined;

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => specPhaseDone({
        featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
        testCommits: [
          {
            sha: "a".repeat(40),
            path: "server/tests/integration/sample.test.ts",
            description: "default",
          },
        ],
        implementationPlan: validImplementationPlan,
      }),
      runCoderPhase: async (input: CoderPhaseInput) => {
        coderInputs.push(input);
        return {
          featureBranch: input.specOutput.featureBranch,
          finalCommitSha: input.priorReview ? "b".repeat(40) : "a".repeat(40),
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
        };
      },
      runReviewPhase: async (input: ReviewerInput) => {
        reviewRounds.push(input.round);
        return {
          verdict: "changes_requested" as const,
          reasoning: "Needs work.",
          findings: [
            {
              path: "src/foo.ts",
              severity: "blocking" as const,
              message: "Null check missing",
            },
          ],
        };
      },
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
      postPullRequestReviewActivity: async () => {
        postReviewCalls += 1;
        // After the round-0 post, fire the cancel signal to the workflow so the
        // next iteration's top-of-loop cancel check transitions to cancelled
        // before another coder dispatch.
        if (postReviewCalls === 1 && cancelHook) {
          await cancelHook();
          cancelSent = true;
        }
        return { reviewId: postReviewCalls, droppedComments: 0 };
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_cancel_between",
                identifier: "ENG-103",
                title: "cancel between rounds",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `ticket-test-${randomUUID()}`,
        });
        cancelHook = async () => {
          await handle.signal(cancelSignal);
        };

        await expect(handle.result()).resolves.toEqual({ status: "cancelled" });
        expect(await handle.query(currentPhaseQuery)).toBe("cancelled");
      });
    });

    expect(cancelSent).toBe(true);
    expect(coderInputs).toHaveLength(1);
    expect(reviewRounds).toEqual([0]);
    expect(postReviewCalls).toBe(1);
    expect(syncedStateNames).toEqual(["In Progress", "Canceled"]);
  }, 30_000);

  it("clarification signal flow: spec returns awaiting → query exposes question → operator signal → spec re-dispatched with priorClarifications → succeeds", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const subTicketRef = {
      id: "issue_clarify_99",
      identifier: "ENG-CL-1",
      title: "[ac-clarification] ENG-7",
    };
    const resolveCalls: Array<{ subTicketId: string; answer: string; resolvedBy?: string }> = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        if (specInputs.length === 1) {
          return {
            kind: "awaiting_clarification" as const,
            subTicketRef,
            reason: "AC §2 ambiguous",
            questions: ["What does merge mean here?"],
          };
        }
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      resolveClarificationSubTicketActivity: async (input) => {
        resolveCalls.push(input);
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_7",
                identifier: "ENG-7",
                title: "needs clarification",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          return c !== undefined;
        });
        const pending = await handle.query(currentClarificationQuery);
        expect(pending).toBeDefined();
        expect(pending?.subTicketRef).toEqual(subTicketRef);
        expect(pending?.reason).toBe("AC §2 ambiguous");
        expect(pending?.questions).toEqual(["What does merge mean here?"]);

        await handle.signal(clarificationAnswerSignal, {
          answer: "Use INSERT ... ON CONFLICT DO UPDATE.",
          resolvedBy: "alice@example.com",
        });

        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });

        // After workflow completes, pending clarification cleared.
        await expect(handle.query(currentClarificationQuery)).resolves.toBeUndefined();
      });
    });

    expect(specInputs).toHaveLength(2);
    expect(specInputs[0].priorClarifications ?? []).toEqual([]);
    expect(specInputs[1].priorClarifications).toEqual([
      {
        reason: "AC §2 ambiguous",
        questions: ["What does merge mean here?"],
        answer: "Use INSERT ... ON CONFLICT DO UPDATE.",
        resolvedBy: "alice@example.com",
      },
    ]);
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toMatchObject({
      subTicketId: subTicketRef.id,
      answer: "Use INSERT ... ON CONFLICT DO UPDATE.",
      resolvedBy: "alice@example.com",
    });
  }, 30_000);

  it("cancel during clarification wait: workflow ends cancelled without re-invoking spec phase", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const syncedStateNames: string[] = [];
    const subTicketRef = {
      id: "issue_clarify_cancel",
      identifier: "ENG-CL-2",
      title: "[ac-clarification] ENG-8",
    };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        return {
          kind: "awaiting_clarification" as const,
          subTicketRef,
          reason: "blocked",
          questions: ["?"],
        };
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      syncLinearTicketStateActivity: async (input) => {
        syncedStateNames.push(input.stateName);
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_8",
                identifier: "ENG-8",
                title: "cancel during wait",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          return c !== undefined;
        });

        await handle.signal(cancelSignal);

        await expect(handle.result()).resolves.toEqual({ status: "cancelled" });
        expect(await handle.query(currentPhaseQuery)).toBe("cancelled");
      });
    });

    expect(specInputs).toHaveLength(1);
    expect(syncedStateNames).toEqual(["In Progress", "Canceled"]);
  }, 30_000);

  it("malformed clarificationAnswer signal is ignored; subsequent valid signal unblocks the workflow", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const subTicketRef = {
      id: "issue_clarify_bad",
      identifier: "ENG-CL-3",
      title: "[ac-clarification] ENG-9",
    };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        if (specInputs.length === 1) {
          return {
            kind: "awaiting_clarification" as const,
            subTicketRef,
            reason: "blocked",
            questions: ["?"],
          };
        }
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_9",
                identifier: "ENG-9",
                title: "malformed signal then valid",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          return c !== undefined;
        });

        // Malformed: missing required `answer` field. Handler must reject and
        // leave the workflow waiting.
        await handle.signal(clarificationAnswerSignal, { resolvedBy: "alice" });

        // Workflow must still be waiting; pendingClarification still set.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const stillPending = await handle.query(currentClarificationQuery);
        expect(stillPending).toBeDefined();
        expect(specInputs).toHaveLength(1);

        // Valid signal unblocks.
        await handle.signal(clarificationAnswerSignal, {
          answer: "use upsert",
          resolvedBy: "alice@example.com",
        });

        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });
      });
    });

    expect(specInputs).toHaveLength(2);
  }, 30_000);

  it("clarification re-dispatch consumes shared PHASE_MAX_ATTEMPTS budget; exhaustion surfaces failure", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const subTicketRef = {
      id: "issue_clarify_exhaust",
      identifier: "ENG-CL-X",
      title: "[ac-clarification] ENG-X",
    };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        // Always return awaiting; with PHASE_MAX_ATTEMPTS=3 and a shared
        // budget, the 3rd response consumes the last slot and the next
        // re-dispatch attempt must fail without invoking runSpecPhase again.
        return {
          kind: "awaiting_clarification" as const,
          subTicketRef,
          reason: `round ${specInputs.length}`,
          questions: [`q${specInputs.length}`],
        };
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_x",
                identifier: "ENG-X",
                title: "exhaust budget",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        // Drive 3 clarification rounds, each consuming one budget slot.
        for (let round = 1; round <= 3; round += 1) {
          await waitFor(async () => {
            const c = await handle.query(currentClarificationQuery);
            return c?.reason === `round ${round}`;
          });
          await handle.signal(clarificationAnswerSignal, {
            answer: `answer ${round}`,
          });
        }

        const failure = await handle.result().then(
          () => {
            throw new Error("expected workflow to fail with budget exhausted");
          },
          (e: unknown) => e,
        );
        expect(failure).toBeInstanceOf(WorkflowFailedError);
        const cause = (failure as WorkflowFailedError).cause;
        expect(cause).toBeInstanceOf(ApplicationFailure);
        expect((cause as ApplicationFailure).type).toBe(
          PHASE_ATTEMPT_BUDGET_EXHAUSTED_FAILURE_TYPE,
        );
      });
    });

    expect(specInputs).toHaveLength(3);
    // Each re-dispatch carries the prior clarification(s) into the next call.
    expect(specInputs[0].priorClarifications ?? []).toEqual([]);
    expect(specInputs[1].priorClarifications).toHaveLength(1);
    expect(specInputs[2].priorClarifications).toHaveLength(2);
  }, 30_000);

  it("clarificationAnswer signal sent before any pending clarification is rejected", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const subTicketRef = {
      id: "issue_clarify_early",
      identifier: "ENG-CL-E",
      title: "[ac-clarification] ENG-E",
    };

    let releaseFirstSpec: () => void = () => {};
    const firstSpecGate = new Promise<void>((resolve) => {
      releaseFirstSpec = resolve;
    });

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        if (specInputs.length === 1) {
          // Hold the first spec activity until the test has sent the early
          // signal — this guarantees pendingClarification is undefined when
          // the signal handler runs.
          await firstSpecGate;
          return {
            kind: "awaiting_clarification" as const,
            subTicketRef,
            reason: "blocked",
            questions: ["?"],
          };
        }
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_e",
                identifier: "ENG-E",
                title: "early signal",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        // Send the early signal before the first spec activity has returned;
        // pendingClarification is undefined so the handler must drop it.
        await handle.signal(clarificationAnswerSignal, {
          answer: "early — must be rejected",
        });

        // Let the spec activity run and surface awaiting_clarification.
        releaseFirstSpec();

        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          return c !== undefined;
        });

        // Workflow must still be waiting — the early signal was rejected, so
        // the spec activity has not been re-dispatched.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        expect(specInputs).toHaveLength(1);
        const stillPending = await handle.query(currentClarificationQuery);
        expect(stillPending).toBeDefined();

        // A subsequent valid signal unblocks the workflow.
        await handle.signal(clarificationAnswerSignal, {
          answer: "real answer",
          resolvedBy: "alice@example.com",
        });

        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });
      });
    });

    expect(specInputs).toHaveLength(2);
    expect(specInputs[1].priorClarifications).toEqual([
      {
        reason: "blocked",
        questions: ["?"],
        answer: "real answer",
        resolvedBy: "alice@example.com",
      },
    ]);
  }, 30_000);

  it("currentClarification query returns undefined immediately after signal received, before sub-ticket resolution completes", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const subTicketRef = {
      id: "issue_clarify_query_clear",
      identifier: "ENG-CL-Q",
      title: "[ac-clarification] ENG-Q",
    };

    let observedDuringResolve: unknown = "not-observed";
    let releaseResolve: () => void = () => {};
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        if (specInputs.length === 1) {
          return {
            kind: "awaiting_clarification" as const,
            subTicketRef,
            reason: "blocked",
            questions: ["?"],
          };
        }
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      resolveClarificationSubTicketActivity: async () => {
        // Hold the activity open so the test can query while the workflow is
        // mid-resolution. The query must already return undefined because the
        // workflow clears pendingClarification immediately after the wait.
        await resolveGate;
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_q",
                identifier: "ENG-Q",
                title: "query clears immediately",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          return c !== undefined;
        });

        await handle.signal(clarificationAnswerSignal, {
          answer: "use upsert",
        });

        // Poll until the query reflects the cleared state. The workflow must
        // clear pendingClarification before awaiting the resolve activity, so
        // this transition happens while the gate is still held.
        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          if (c === undefined) {
            observedDuringResolve = "undefined";
            return true;
          }
          return false;
        });

        // Release the resolve activity so the workflow can finish.
        releaseResolve();

        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });
      });
    });

    expect(observedDuringResolve).toBe("undefined");
    expect(specInputs).toHaveLength(2);
  }, 30_000);

  it("resolveClarificationSubTicketActivity failure is best-effort: workflow still re-dispatches spec phase", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const specInputs: SpecPhaseInput[] = [];
    const subTicketRef = {
      id: "issue_clarify_resolve_fail",
      identifier: "ENG-CL-4",
      title: "[ac-clarification] ENG-10",
    };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        specInputs.push(input);
        if (specInputs.length === 1) {
          return {
            kind: "awaiting_clarification" as const,
            subTicketRef,
            reason: "blocked",
            questions: ["?"],
          };
        }
        return specPhaseDone({
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
          implementationPlan: validImplementationPlan,
        });
      },
      runCoderPhase: async (input: CoderPhaseInput) => ({
        featureBranch: input.specOutput.featureBranch,
        finalCommitSha: "f".repeat(40),
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      }),
      runReviewPhase: async (_input: ReviewerInput) => ({
        verdict: "approve" as const,
        reasoning: "ok",
        findings: [],
      }),
    };

    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      ...phaseActivities,
      resolveClarificationSubTicketActivity: async () => {
        // Simulate Linear outage that exhausts retries with a non-retryable
        // failure so the workflow's try/catch swallows it.
        throw ApplicationFailure.nonRetryable(
          "Linear API down",
          "LinearOutage",
        );
      },
    };

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: {
                id: "issue_10",
                identifier: "ENG-10",
                title: "resolve activity fails",
                description: "",
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `test-ticket-${randomUUID()}`,
        });

        await waitFor(async () => {
          const c = await handle.query(currentClarificationQuery);
          return c !== undefined;
        });

        await handle.signal(clarificationAnswerSignal, {
          answer: "use upsert",
        });

        await expect(handle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });
      });
    });

    expect(specInputs).toHaveLength(2);
  }, 30_000);
});

function buildBaseActivities(): TemporalWorkerActivities {
  return {
    helloActivity: async (name: string) => `hello, ${name}`,
    listAgentReadyTicketsActivity: async () => [],
    syncLinearTicketStateActivity: async (_input) => {},
    resolveClarificationSubTicketActivity: async (_input) => {},
    runSpecPhase: async (_input: SpecPhaseInput) => specPhaseDone({
      featureBranch: "agent/spec",
      testCommits: [
        {
          sha: "a".repeat(40),
          path: "server/tests/integration/sample.test.ts",
          description: "default",
        },
      ],
      implementationPlan: validImplementationPlan,
    }),
    runCoderPhase: async (input: CoderPhaseInput) => ({
      featureBranch: input.specOutput.featureBranch,
      finalCommitSha: "c".repeat(40),
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
    }),
    runReviewPhase: async (_input: ReviewerInput) => ({
      verdict: "approve",
      reasoning: "ok",
      findings: [],
    }),
    launchWorkerContainer: async (
      input: LaunchWorkerContainerInput,
    ): Promise<LaunchWorkerContainerResult> => ({
      containerId: `stub-${input.attemptId}`,
      queue: taskQueueForRepo(input.repoSlug),
      logsPath: `/tmp/test-logs/${input.attemptId}`,
    }),
    validateRepoSlug: async (_input: { slug: string }): Promise<void> => {},
    openPullRequestActivity: async () => ({
      number: 1,
      url: "https://github.test/example/pr/1",
    }),
    postPullRequestReviewActivity: async () => ({
      reviewId: 1,
      droppedComments: 0,
    }),
  };
}

// Walks WorkflowFailedError → ActivityFailure → ApplicationFailure and asserts
// the activity threw a non-retryable `type` carrying the expected subTicketRef
// in `details`. Spec §3 requires stuck workflow failures to surface the
// sub-ticket reference so downstream operators can find the Linear sub-ticket.
async function assertStuckSubTicketRef(
  result: Promise<unknown>,
  expectedType: string,
  expectedSubTicketRef: { id: string; identifier: string; title: string },
): Promise<void> {
  const error = await result.then(
    () => {
      throw new Error("workflow result resolved; expected WorkflowFailedError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkflowFailedError);
  const activityFailure = (error as WorkflowFailedError).cause;
  expect(activityFailure).toBeInstanceOf(ActivityFailure);
  const appFailure = (activityFailure as ActivityFailure).cause;
  expect(appFailure).toBeInstanceOf(ApplicationFailure);
  const af = appFailure as ApplicationFailure;
  expect(af.type).toBe(expectedType);
  expect(af.nonRetryable).toBe(true);
  expect(af.details).toEqual([{ subTicketRef: expectedSubTicketRef }]);
}

async function assertTemporalPortReachable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 7233 });

    socket.once("connect", () => {
      socket.end();
      resolve();
    });

    socket.once("error", () => {
      reject(
        new Error(
          "Temporal frontend is unreachable on localhost:7233. Start it with 'docker compose up -d temporal temporal-ui' and re-run tests.",
        ),
      );
    });

    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(
        new Error(
          "Temporal frontend connect timed out on localhost:7233. Start it with 'docker compose up -d temporal temporal-ui' and re-run tests.",
        ),
      );
    });
  });
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition was not met before timeout");
}
