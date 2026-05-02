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
  currentPhaseQuery,
  PER_TICKET_WORKFLOW_NAME,
  attemptCountQuery,
} from "../../src/temporal/workflows/per-ticket.js";
import type { CoderPhaseInput, SpecPhaseInput } from "../../src/temporal/activities/phases.js";
import type { SpecPhaseOutput } from "../../src/agents/contracts/index.js";
import type { ReviewerInput } from "../../src/agents/contracts/index.js";
import type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
} from "../../src/temporal/activities/worker-launcher.js";

// Each test gets a unique slug (and therefore a unique per-repo task queue)
// so that pending activity tasks left over from prior test runs in the shared
// Temporal namespace cannot be claimed by a later test's worker. Without this,
// a leftover spec/coder task from a previous run pollutes phaseCalls and
// breaks deterministic phase-sequence assertions.
let TEST_REPO_SLUG: string;
let TEST_REPO_QUEUE: string;

describe("Temporal per-ticket workflow orchestration", () => {
  beforeEach(() => {
    TEST_REPO_SLUG = `test-repo-${randomUUID()}`;
    TEST_REPO_QUEUE = taskQueueForRepo(TEST_REPO_SLUG);
  });


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

  it("DepMissingRequested from coder phase: review NOT invoked, ticket stays In Progress", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const syncedStateNames: string[] = [];
    const subTicketRef = { id: "issue_dep", identifier: "ENG-DEP-1", title: "dep-missing for ENG-3" };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return {
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
        };
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
          workflowId: `ticket-test-${randomUUID()}`,
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
  }, 30_000);

  it("DesignQuestionRequested from coder phase: review NOT invoked, ticket stays In Progress", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const syncedStateNames: string[] = [];
    const subTicketRef = { id: "issue_dq", identifier: "ENG-DQ-1", title: "design-question for ENG-4" };

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return {
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
        };
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
          workflowId: `ticket-test-${randomUUID()}`,
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

  it("happy coder result: review phase invoked with coder output", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];
    const seenReviewerInputs: ReviewerInput[] = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return {
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
        };
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
          workflowId: `ticket-test-${randomUUID()}`,
        });
        await expect(handle.result()).resolves.toEqual({ status: "succeeded" });
      });
    });

    expect(phaseCalls).toEqual(["spec", "coder", "review"]);
    expect(seenReviewerInputs).toHaveLength(1);
    expect(seenReviewerInputs[0].finalCommitSha).toBe("f".repeat(40));
    expect(seenReviewerInputs[0].diffStat).toEqual({ filesChanged: 2, insertions: 7, deletions: 1 });
    expect(seenReviewerInputs[0].testRunSummary.passed).toBe(4);
  }, 30_000);

  it("generic non-stuck failure surfaces via normal Temporal failure semantics", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const phaseCalls: string[] = [];

    const phaseActivities = {
      runSpecPhase: async (input: SpecPhaseInput) => {
        phaseCalls.push("spec");
        return {
          featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
          testCommits: [
            {
              sha: "a".repeat(40),
              path: "server/tests/integration/sample.test.ts",
              description: "default",
            },
          ],
        };
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
          workflowId: `ticket-test-${randomUUID()}`,
        });

        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      });
    });

    expect(phaseCalls).toContain("coder");
    expect(phaseCalls).not.toContain("review");
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
