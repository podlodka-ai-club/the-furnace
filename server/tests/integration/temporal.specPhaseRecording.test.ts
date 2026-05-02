import { randomUUID } from "node:crypto";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import {
  createPerRepoWorker,
  createTemporalWorker,
  type TemporalWorkerActivities,
} from "../../src/temporal/worker.js";
import { createTemporalClient } from "../../src/temporal/client.js";
import { TEMPORAL_TASK_QUEUE } from "../../src/temporal/config.js";
import { taskQueueForRepo } from "../../src/temporal/repo-slug.js";
import {
  buildPerTicketWorkflowId,
  PER_TICKET_WORKFLOW_NAME,
} from "../../src/temporal/workflows/per-ticket.js";
import type { SpecPhaseInput } from "../../src/temporal/activities/phases.js";
import type { SpecPhaseOutput, ReviewerInput } from "../../src/agents/contracts/index.js";
import type {
  PersistWorkflowRunStartInput,
  PersistWorkflowRunTransitionInput,
} from "../../src/temporal/activities/workflow-runs.js";
import type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
} from "../../src/temporal/activities/worker-launcher.js";
import type { RecordAttemptInput } from "../../src/temporal/activities/attempts.js";

const TEST_REPO_SLUG = "test-repo";
const TEST_REPO_QUEUE = taskQueueForRepo(TEST_REPO_SLUG);

interface RecordedCalls {
  recordAttempt: RecordAttemptInput[];
  transitions: PersistWorkflowRunTransitionInput[];
  // syncLinearTicketStateActivity calls keyed by ticketId — filter by the
  // current test's ticketId to avoid pollution from concurrent workflows on
  // the same task queue.
  syncCalls: { ticketId: string; stateName: string }[];
  // phaseCalls keyed by ticketId for the same reason.
  phaseCalls: { ticketId: string; phase: "spec" | "coder" | "review" }[];
}

describe("Temporal spec phase recording", () => {
  it("clarification path: records 'stuck', persists 'failed', skips coder, leaves ticket In Progress", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `issue_${randomUUID()}`;
    const workflowId = buildPerTicketWorkflowId(ticketId);
    const recorded: RecordedCalls = {
      recordAttempt: [],
      transitions: [],
      syncCalls: [],
      phaseCalls: [],
    };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        recorded.phaseCalls.push({ ticketId: input.ticket.id, phase: "spec" });
        throw ApplicationFailure.nonRetryable(
          "Spec agent requested AC clarification: opened ENG-99",
          "AcClarificationRequested",
          { subTicketRef: { id: "issue_99", identifier: "ENG-99", title: "[ac-clarification]" } },
        );
      },
      runCoderPhase: async (input: SpecPhaseOutput) => {
        // Track phase calls without a ticketId on the input — but we don't
        // expect this to fire on the clarification path. If it does, it's
        // either pollution (different workflow) or a bug.
        recorded.phaseCalls.push({ ticketId: "<unknown>", phase: "coder" });
        return {
          featureBranch: input.featureBranch,
          finalCommitSha: "c".repeat(40),
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
        };
      },
      runReviewPhase: async (input: ReviewerInput) => {
        recorded.phaseCalls.push({ ticketId: input.ticket.id, phase: "review" });
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities = buildBaseActivities(recorded, phaseActivities);

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    let workflowError: unknown;

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: { id: ticketId, identifier: "ENG-100", title: "Clarification ticket", description: "" },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId,
        });
        try {
          await handle.result();
        } catch (err) {
          workflowError = err;
        }
      });
    });

    expect(workflowError).toBeDefined();

    const myPhaseCalls = recorded.phaseCalls.filter((c) => c.ticketId === ticketId);
    expect(myPhaseCalls.map((c) => c.phase)).toEqual(["spec"]);

    const myAttempts = recorded.recordAttempt.filter((a) => a.workflowId === workflowId);
    const specOutcomes = myAttempts.filter((a) => a.phase === "spec").map((a) => a.outcome);
    expect(specOutcomes).toEqual(["pending", "stuck"]);
    expect(myAttempts.some((a) => a.outcome === "passed")).toBe(false);
    expect(myAttempts.some((a) => a.outcome === "failed")).toBe(false);

    const myTransitions = recorded.transitions.filter((t) => t.workflowId === workflowId);
    expect(myTransitions.at(-1)?.status).toBe("failed");

    const mySyncs = recorded.syncCalls.filter((s) => s.ticketId === ticketId);
    expect(mySyncs.map((s) => s.stateName)).toEqual(["In Progress"]);
  }, 30_000);

  it("success path: records 'passed' on spec and proceeds through coder + review", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `issue_${randomUUID()}`;
    const workflowId = buildPerTicketWorkflowId(ticketId);
    const recorded: RecordedCalls = {
      recordAttempt: [],
      transitions: [],
      syncCalls: [],
      phaseCalls: [],
    };

    // Used to thread the ticketId through coder phase output -> review.
    const featureBranchForTicket = `agent/spec-eng-200-${ticketId}`;

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        recorded.phaseCalls.push({ ticketId: input.ticket.id, phase: "spec" });
        return {
          featureBranch: featureBranchForTicket,
          testCommits: [
            { sha: "a".repeat(40), path: "tests/x.test.ts", description: "covers feature X" },
          ],
        };
      },
      runCoderPhase: async (input: SpecPhaseOutput) => {
        // Recognize THIS test's coder call by its featureBranch.
        const isMine = input.featureBranch === featureBranchForTicket;
        recorded.phaseCalls.push({ ticketId: isMine ? ticketId : "<other>", phase: "coder" });
        return {
          featureBranch: input.featureBranch,
          finalCommitSha: "c".repeat(40),
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
        };
      },
      runReviewPhase: async (input: ReviewerInput) => {
        recorded.phaseCalls.push({ ticketId: input.ticket.id, phase: "review" });
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities = buildBaseActivities(recorded, phaseActivities);

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
              ticket: { id: ticketId, identifier: "ENG-200", title: "Success ticket", description: "" },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId,
        });
        await expect(handle.result()).resolves.toEqual({ status: "succeeded" });
      });
    });

    const myPhaseCalls = recorded.phaseCalls.filter((c) => c.ticketId === ticketId);
    expect(myPhaseCalls.map((c) => c.phase)).toEqual(["spec", "coder", "review"]);

    const myAttempts = recorded.recordAttempt.filter((a) => a.workflowId === workflowId);
    const specOutcomes = myAttempts.filter((a) => a.phase === "spec").map((a) => a.outcome);
    expect(specOutcomes).toEqual(["pending", "passed"]);

    const mySyncs = recorded.syncCalls.filter((s) => s.ticketId === ticketId);
    expect(mySyncs.map((s) => s.stateName)).toEqual(["In Progress", "Done"]);
  }, 30_000);

  it("generic spec failure: records 'failed' and surfaces the failure", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `issue_${randomUUID()}`;
    const workflowId = buildPerTicketWorkflowId(ticketId);
    const recorded: RecordedCalls = {
      recordAttempt: [],
      transitions: [],
      syncCalls: [],
      phaseCalls: [],
    };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        recorded.phaseCalls.push({ ticketId: input.ticket.id, phase: "spec" });
        throw ApplicationFailure.nonRetryable(
          "spec agent exhausted budget",
          "SpecAgentBudgetExhausted",
        );
      },
      runCoderPhase: async (input: SpecPhaseOutput) => {
        recorded.phaseCalls.push({ ticketId: "<unknown>", phase: "coder" });
        return {
          featureBranch: input.featureBranch,
          finalCommitSha: "c".repeat(40),
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
        };
      },
      runReviewPhase: async (input: ReviewerInput) => {
        recorded.phaseCalls.push({ ticketId: input.ticket.id, phase: "review" });
        return { verdict: "approve" as const, reasoning: "ok", findings: [] };
      },
    };

    const activities = buildBaseActivities(recorded, phaseActivities);

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities });
    const repoWorker = await createPerRepoWorker({
      taskQueue: TEST_REPO_QUEUE,
      activities: phaseActivities,
    });

    let workflowError: unknown;

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
          args: [
            {
              ticket: { id: ticketId, identifier: "ENG-300", title: "Generic failure ticket", description: "" },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId,
        });
        try {
          await handle.result();
        } catch (err) {
          workflowError = err;
        }
      });
    });

    expect(workflowError).toBeDefined();

    const myPhaseCalls = recorded.phaseCalls.filter((c) => c.ticketId === ticketId);
    expect(myPhaseCalls.map((c) => c.phase)).toEqual(["spec"]);

    const myAttempts = recorded.recordAttempt.filter((a) => a.workflowId === workflowId);
    const specOutcomes = myAttempts.filter((a) => a.phase === "spec").map((a) => a.outcome);
    expect(specOutcomes).toEqual(["pending", "failed"]);
    expect(myAttempts.some((a) => a.outcome === "passed")).toBe(false);
    expect(myAttempts.some((a) => a.outcome === "stuck")).toBe(false);
  }, 30_000);
});

function buildBaseActivities(
  recorded: RecordedCalls,
  phaseActivities: Pick<TemporalWorkerActivities, "runSpecPhase" | "runCoderPhase" | "runReviewPhase">,
): TemporalWorkerActivities {
  return {
    helloActivity: async (name: string) => `hello, ${name}`,
    listAgentReadyTicketsActivity: async () => [],
    syncLinearTicketStateActivity: async (input) => {
      recorded.syncCalls.push({ ticketId: input.ticketId, stateName: input.stateName });
    },
    ...phaseActivities,
    persistWorkflowRunStart: async (_input: PersistWorkflowRunStartInput) => {},
    persistWorkflowRunTransition: async (input: PersistWorkflowRunTransitionInput) => {
      recorded.transitions.push(input);
    },
    recordAttempt: async (input: RecordAttemptInput) => {
      recorded.recordAttempt.push(input);
    },
    launchWorkerContainer: async (
      input: LaunchWorkerContainerInput,
    ): Promise<LaunchWorkerContainerResult> => ({
      containerId: `stub-${input.attemptId}`,
      queue: taskQueueForRepo(input.repoSlug),
      logsPath: `/tmp/test-logs/${input.attemptId}`,
    }),
    validateRepoSlug: async (_input: { slug: string }): Promise<void> => {},
  };
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
