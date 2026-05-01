import { randomUUID } from "node:crypto";
import net from "node:net";
import { describe, expect, it } from "vitest";
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
  currentPhaseQuery,
  PER_TICKET_WORKFLOW_NAME,
  attemptCountQuery,
} from "../../src/temporal/workflows/per-ticket.js";
import type { SpecPhaseInput } from "../../src/temporal/activities/phases.js";
import type { SpecPhaseOutput } from "../../src/agents/contracts/index.js";
import type { ReviewerInput } from "../../src/agents/contracts/index.js";
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

describe("Temporal per-ticket workflow orchestration", () => {
  it("poller starts ticket workflows idempotently by ticket ID", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `issue-${randomUUID()}`;
    const activities: TemporalWorkerActivities = {
      ...buildBaseActivities(),
      listAgentReadyTicketsActivity: async () => [
        {
          id: ticketId,
          identifier: "ENG-1",
          title: "Agent-ready ticket",
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
        workflowId: `poller-${randomUUID()}`,
      });

      const firstPollResult = await firstPoll.result();
      expect(firstPollResult.discovered).toBe(1);
      expect(firstPollResult.started + firstPollResult.skipped).toBe(1);

      const secondPoll = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
        args: [],
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowId: `poller-${randomUUID()}`,
      });

      const secondPollResult = await secondPoll.result();
      expect(secondPollResult.discovered).toBe(1);
      expect(secondPollResult.started + secondPollResult.skipped).toBe(1);
    });
  }, 30_000);

  it("keeps per-ticket workflow alive after poller completion", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const ticketId = `issue-${randomUUID()}`;
    const syncedStateNames: string[] = [];
    let releaseSpec: (() => void) | undefined;
    const specGate = new Promise<void>((resolve) => {
      releaseSpec = resolve;
    });

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        await specGate;
        return {
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: `Failing acceptance tests for ${input.ticket.identifier}`,
            },
          ],
        };
      },
      runCoderPhase: async (input: SpecPhaseOutput) => ({
        status: "success" as const,
        featureBranch: input.featureBranch,
        finalCommitSha: "c".repeat(40),
        diffManifest: {
          baseCommitSha: "b".repeat(40),
          headCommitSha: "c".repeat(40),
          files: [{ path: "server/src/app.ts", changeType: "M" as const }],
        },
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
            workflowId: `poller-${randomUUID()}`,
          });

          await expect(pollerHandle.result()).resolves.toEqual({
            discovered: 1,
            started: 1,
            skipped: 0,
          });

          const ticketHandle = client.workflow.getHandle(buildPerTicketWorkflowId(ticketId));
          await waitFor(async () => (await ticketHandle.query(currentPhaseQuery)) === "spec");

          releaseSpec?.();
          await expect(ticketHandle.result()).resolves.toEqual({ status: "succeeded" });
        });
      }),
    ]);

    expect(syncedStateNames).toEqual(["In Progress", "Done"]);
  }, 30_000);

  it("runs phases in order, supports cancel signal, and answers queries", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const syncedStateNames: string[] = [];
    let releaseSpec: (() => void) | undefined;
    const specGate = new Promise<void>((resolve) => {
      releaseSpec = resolve;
    });

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        await specGate;
        return {
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: `Failing acceptance tests for ${input.ticket.identifier}`,
            },
          ],
        };
      },
      runCoderPhase: async (input: SpecPhaseOutput) => {
        phaseCalls.push("coder");
        return {
          status: "success" as const,
          featureBranch: input.featureBranch,
          finalCommitSha: "d".repeat(40),
          diffManifest: {
            baseCommitSha: "c".repeat(40),
            headCommitSha: "d".repeat(40),
            files: [{ path: "server/src/app.ts", changeType: "M" as const }],
          },
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
              },
              targetRepoSlug: TEST_REPO_SLUG,
            },
          ],
          taskQueue: TEMPORAL_TASK_QUEUE,
          workflowId: `ticket-test-${randomUUID()}`,
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
  }, 30_000);
});

function buildBaseActivities(): TemporalWorkerActivities {
  return {
    helloActivity: async (name: string) => `hello, ${name}`,
    listAgentReadyTicketsActivity: async () => [],
    syncLinearTicketStateActivity: async (_input) => {},
    runSpecPhase: async (_input: SpecPhaseInput) => ({
      featureBranch: "agent/spec",
      testCommits: [
        {
          sha: "a".repeat(40),
          path: "server/tests/integration/sample.test.ts",
          description: "default",
        },
      ],
    }),
    runCoderPhase: async (input: SpecPhaseOutput) => ({
      status: "success" as const,
      featureBranch: input.featureBranch,
      finalCommitSha: "c".repeat(40),
      diffManifest: {
        baseCommitSha: "b".repeat(40),
        headCommitSha: "c".repeat(40),
        files: [{ path: "server/src/app.ts", changeType: "M" as const }],
      },
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
    }),
    runReviewPhase: async (_input: ReviewerInput) => ({
      verdict: "approve",
      reasoning: "ok",
      findings: [],
    }),
    persistWorkflowRunStart: async (_input: PersistWorkflowRunStartInput) => {},
    persistWorkflowRunTransition: async (_input: PersistWorkflowRunTransitionInput) => {},
    recordAttempt: async (_input: RecordAttemptInput) => {},
    launchWorkerContainer: async (
      input: LaunchWorkerContainerInput,
    ): Promise<LaunchWorkerContainerResult> => ({
      containerId: `stub-${input.attemptId}`,
      queue: taskQueueForRepo(input.repoSlug),
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
