import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTemporalClient } from "../../src/temporal/client.js";
import {
  createTemporalWorker,
  type TemporalWorkerActivities,
} from "../../src/temporal/worker.js";
import { TEMPORAL_TASK_QUEUE } from "../../src/temporal/config.js";
import { taskQueueForRepo } from "../../src/temporal/repo-slug.js";
import {
  buildPerTicketWorkflowId,
  PER_TICKET_WORKFLOW_NAME,
  currentPhaseQuery,
  type PerTicketWorkflowInput,
} from "../../src/temporal/workflows/per-ticket.js";
import type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
} from "../../src/temporal/activities/worker-launcher.js";

// Each test gets a unique slug (and therefore a unique per-repo task queue) so
// that pending activity tasks left over from prior test runs in the shared
// Temporal namespace cannot be claimed by a later test's worker.
let TEST_REPO_SLUG: string;

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TESTS_DIR, "..", "..");
// Container-lifecycle tests use the test entry (fixtures/test-worker-entry.ts)
// because the production runSpecPhase now drives the Claude Agent SDK and
// requires Linear/DB infrastructure these lifecycle tests don't provide. The
// test entry exposes the same `runContainerWorker` boot sequence with fast
// noop phase activities, so these tests still exercise the real worker
// lifecycle (spawn, register, claim task, shutdown) without the spec body.
const TEST_WORKER_ENTRY = path.join(TESTS_DIR, "fixtures", "test-worker-entry.ts");
const TSX_BIN = path.join(SERVER_DIR, "node_modules", ".bin", "tsx");

interface SpawnedChild {
  containerId: string;
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnChildWorker(
  input: LaunchWorkerContainerInput,
  entryPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnedChild {
  const containerId = `child-${input.attemptId}-${randomUUID().slice(0, 6)}`;
  const child = spawn(TSX_BIN, [entryPath], {
    env: {
      ...process.env,
      WORKER_REPO: input.repoSlug,
      WORKER_ATTEMPT_ID: input.attemptId,
      TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
      TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "default",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[${containerId} stdout] ${chunk.toString("utf8")}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${containerId} stderr] ${chunk.toString("utf8")}`);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return { containerId, child, exit };
}

interface OrchestratorState {
  launchCalls: LaunchWorkerContainerInput[];
  validateCalls: string[];
  spawned: SpawnedChild[];
}

function buildOrchestratorActivities(
  state: OrchestratorState,
  overrides: Partial<TemporalWorkerActivities> = {},
  launchBehavior: (input: LaunchWorkerContainerInput) => SpawnedChild | null = (input) => {
    const c = spawnChildWorker(input, TEST_WORKER_ENTRY);
    return c;
  },
): Partial<TemporalWorkerActivities> {
  return {
    helloActivity: async (n: string) => `hello, ${n}`,
    listAgentReadyTicketsActivity: async () => [],
    syncLinearTicketStateActivity: async () => {},
    openPullRequestActivity: async () => ({
      number: 1,
      url: "https://github.test/example/pr/1",
    }),
    validateRepoSlug: async ({ slug }) => {
      state.validateCalls.push(slug);
    },
    launchWorkerContainer: async (
      input: LaunchWorkerContainerInput,
    ): Promise<LaunchWorkerContainerResult> => {
      state.launchCalls.push(input);
      const spawned = launchBehavior(input);
      if (spawned) {
        state.spawned.push(spawned);
      }
      return {
        containerId: spawned?.containerId ?? `noop-${input.attemptId}`,
        queue: taskQueueForRepo(input.repoSlug),
        logsPath: `/tmp/test-logs/${input.attemptId}`,
      };
    },
    ...overrides,
  };
}

async function killAllChildren(state: OrchestratorState): Promise<void> {
  for (const s of state.spawned) {
    if (s.child.exitCode === null && s.child.signalCode === null) {
      s.child.kill("SIGKILL");
    }
  }
  await Promise.allSettled(state.spawned.map((s) => s.exit));
}

describe("container-as-worker lifecycle", () => {
  beforeEach(() => {
    TEST_REPO_SLUG = `test-repo-${randomUUID()}`;
  });

  const sharedState: OrchestratorState = {
    launchCalls: [],
    validateCalls: [],
    spawned: [],
  };

  // Use a unique orchestrator task queue per test so leftover tasks from prior
  // (possibly aborted) test runs in the same Temporal namespace can't be picked
  // up by the worker we boot in this test.
  let orchTaskQueue = TEMPORAL_TASK_QUEUE;

  afterEach(async () => {
    await killAllChildren(sharedState);
    sharedState.launchCalls = [];
    sharedState.validateCalls = [];
    sharedState.spawned = [];
  });

  it("8.3 + 8.5: spawned child completes one phase activity and exits 0; phases dispatch on per-repo queue", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-83-${randomUUID()}`;
    const orchActivities = buildOrchestratorActivities(sharedState);
    const orchWorker = await createTemporalWorker({
      activities: orchActivities,
      injectPhaseActivities: false,
      taskQueue: orchTaskQueue,
    });
    const client = await createTemporalClient();

    await orchWorker.runUntil(async () => {
      const ticketId = `issue-${randomUUID()}`;
      const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
        args: [
          {
            ticket: { id: ticketId, identifier: "ENG-A", title: "Container lifecycle", description: "" },
            targetRepoSlug: TEST_REPO_SLUG,
          } satisfies PerTicketWorkflowInput,
        ],
        taskQueue: orchTaskQueue,
        workflowId: buildPerTicketWorkflowId(ticketId),
      });

      await expect(handle.result()).resolves.toEqual({
        status: "succeeded",
        pr: { number: 1, url: "https://github.test/example/pr/1" },
      });
    });

    await Promise.all(sharedState.spawned.map((s) => s.exit));

    expect(sharedState.validateCalls).toEqual([TEST_REPO_SLUG]);
    expect(sharedState.launchCalls.map((c) => c.phase)).toEqual([
      "spec",
      "coder",
      "review",
    ]);
    for (const call of sharedState.launchCalls) {
      expect(call.repoSlug).toBe(TEST_REPO_SLUG);
    }

    expect(sharedState.spawned).toHaveLength(3);
    for (const spawned of sharedState.spawned) {
      const result = await spawned.exit;
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    }
  }, 60_000);

  it("8.4: SIGTERM during in-flight activity → CancelledFailure → fresh container completes the retry", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    // The workflow's runPhase loop launches a fresh container for every phase
    // attempt (see workflows/per-ticket.ts). When the first spec container is
    // SIGTERM'd mid-activity, the activity surfaces a failure to the workflow,
    // runPhase catches it, increments the attempt counter, and calls
    // launchWorkerContainer again — producing a fresh worker on the per-repo
    // queue that completes the retry. This test exercises that path end-to-end.
    let firstSpecSpawned = false;
    const launchBehavior = (input: LaunchWorkerContainerInput): SpawnedChild => {
      if (input.phase === "spec" && !firstSpecSpawned) {
        firstSpecSpawned = true;
        return spawnChildWorker(input, TEST_WORKER_ENTRY, {
          WORKER_TEST_BEHAVIOR: "block",
        });
      }
      return spawnChildWorker(input, TEST_WORKER_ENTRY);
    };

    orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-84-${randomUUID()}`;
    const orchActivities = buildOrchestratorActivities(
      sharedState,
      {},
      launchBehavior,
    );
    const orchWorker = await createTemporalWorker({
      activities: orchActivities,
      injectPhaseActivities: false,
      taskQueue: orchTaskQueue,
    });
    const client = await createTemporalClient();

    await orchWorker.runUntil(async () => {
      const ticketId = `issue-${randomUUID()}`;
      const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
        args: [
          {
            ticket: { id: ticketId, identifier: "ENG-B", title: "Cancelable phase", description: "" },
            targetRepoSlug: TEST_REPO_SLUG,
          } satisfies PerTicketWorkflowInput,
        ],
        taskQueue: orchTaskQueue,
        workflowId: buildPerTicketWorkflowId(ticketId),
      });

      await waitFor(
        async () =>
          (await handle.query(currentPhaseQuery)) === "spec" &&
          sharedState.spawned.length > 0,
      );
      const blockingChild = sharedState.spawned[0];
      expect(blockingChild).toBeDefined();
      // Give the child enough time to register its worker and pick up the task.
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      blockingChild.child.kill("SIGTERM");
      const blockingExit = await blockingChild.exit;
      // SIGTERM → graceful worker.shutdown → activity raises CancelledFailure →
      // singleTaskActivity wrapper records failure → process exits non-zero.
      expect(blockingExit.signal === null || blockingExit.signal === "SIGTERM").toBe(true);

      await expect(handle.result()).resolves.toEqual({
        status: "succeeded",
        pr: { number: 1, url: "https://github.test/example/pr/1" },
      });
    });

    await Promise.all(sharedState.spawned.map((s) => s.exit));

    const phases = sharedState.launchCalls.map((c) => c.phase);
    // Spec must appear at least twice: the killed first attempt, and a retry
    // launched by runPhase. Coder and review follow on subsequent launches.
    expect(phases.filter((p) => p === "spec").length).toBeGreaterThanOrEqual(2);
    expect(phases).toContain("coder");
    expect(phases).toContain("review");

    expect(sharedState.spawned.length).toBeGreaterThanOrEqual(4);
    const blockingResult = await sharedState.spawned[0].exit;
    expect(blockingResult.signal === null || blockingResult.signal === "SIGTERM").toBe(true);
  }, 90_000);

  it("8.6a: workflow fails fast when targetRepoSlug is empty, before any container launch", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-86a-${randomUUID()}`;
    const orchActivities = buildOrchestratorActivities(sharedState);
    const orchWorker = await createTemporalWorker({
      activities: orchActivities,
      injectPhaseActivities: false,
      taskQueue: orchTaskQueue,
    });
    const client = await createTemporalClient();

    await orchWorker.runUntil(async () => {
      const ticketId = `issue-${randomUUID()}`;
      const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
        args: [
          {
            ticket: { id: ticketId, identifier: "ENG-C", title: "Missing slug", description: "" },
            targetRepoSlug: "",
          } satisfies PerTicketWorkflowInput,
        ],
        taskQueue: orchTaskQueue,
        workflowId: buildPerTicketWorkflowId(ticketId),
      });

      await expectRejectionMessage(handle.result(), /targetRepoSlug/i);
    });

    expect(sharedState.launchCalls).toHaveLength(0);
    expect(sharedState.validateCalls).toHaveLength(0);
  }, 30_000);

  it("8.6b: workflow fails fast when targetRepoSlug is unknown, before any container launch", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-86b-${randomUUID()}`;
    const orchActivities = buildOrchestratorActivities(sharedState, {
      validateRepoSlug: async ({ slug }) => {
        sharedState.validateCalls.push(slug);
        throw new Error(`Unknown repo slug '${slug}'. Known slugs: ${TEST_REPO_SLUG}`);
      },
    });
    const orchWorker = await createTemporalWorker({
      activities: orchActivities,
      injectPhaseActivities: false,
      taskQueue: orchTaskQueue,
    });
    const client = await createTemporalClient();

    await orchWorker.runUntil(async () => {
      const ticketId = `issue-${randomUUID()}`;
      const handle = await client.workflow.start(PER_TICKET_WORKFLOW_NAME, {
        args: [
          {
            ticket: { id: ticketId, identifier: "ENG-D", title: "Unknown slug", description: "" },
            targetRepoSlug: "no-such-slug",
          } satisfies PerTicketWorkflowInput,
        ],
        taskQueue: orchTaskQueue,
        workflowId: buildPerTicketWorkflowId(ticketId),
      });

      await expectRejectionMessage(handle.result(), /Unknown repo slug/);
    });

    expect(sharedState.validateCalls).toEqual(["no-such-slug"]);
    expect(sharedState.launchCalls).toHaveLength(0);
  }, 30_000);
});

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

async function expectRejectionMessage(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error("expected promise to reject");
  }
  // Temporal wraps activity failures in WorkflowFailedError → ApplicationFailure;
  // walk the cause chain to find the originating message.
  const messages: string[] = [];
  let cursor: unknown = caught;
  while (cursor instanceof Error) {
    messages.push(cursor.message);
    cursor = (cursor as Error & { cause?: unknown }).cause;
  }
  const joined = messages.join(" | ");
  expect(joined).toMatch(pattern);
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await assertion()) {
        return;
      }
    } catch {
      // queries can race startup; ignore until timeout
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition was not met before timeout");
}
