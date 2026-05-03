import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearClient } from "../../src/linear/client.js";
import {
  createPerRepoWorker,
  createTemporalWorker,
  type TemporalWorkerActivities,
} from "../../src/temporal/worker.js";
import { createTemporalClient } from "../../src/temporal/client.js";
import { TEMPORAL_TASK_QUEUE } from "../../src/temporal/config.js";
import { taskQueueForRepo } from "../../src/temporal/repo-slug.js";
import { LINEAR_POLLER_WORKFLOW_NAME } from "../../src/temporal/workflows/linear-poller.js";
import { buildPerTicketWorkflowId } from "../../src/temporal/workflows/per-ticket.js";
import type { CoderPhaseInput, SpecPhaseInput } from "../../src/temporal/activities/phases.js";
import type {
  CoderPhaseOutput,
  ReviewerInput,
  SpecPhaseOutput,
} from "../../src/agents/contracts/index.js";
import type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
} from "../../src/temporal/activities/worker-launcher.js";
import { installWorkflowCleanupHook } from "./helpers/workflow-cleanup.js";
import { validImplementationPlan } from "../agents/contracts/fixtures.js";

const TEST_REPO_SLUG = "test-repo";
const TEST_REGISTRY: ReadonlySet<string> = new Set([TEST_REPO_SLUG]);

interface IssueNodeInput {
  id: string;
  identifier: string;
  title: string;
  labelNames: string[];
  description?: string | null;
}

function makeIssueNode(input: IssueNodeInput): {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  labelIds: string[];
  labels: { nodes: Array<{ id: string; name: string }> };
} {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: input.description ?? null,
    priority: 1,
    labelIds: input.labelNames.map((n) => `label-${n}`),
    labels: {
      nodes: input.labelNames.map((n) => ({ id: `label-${n}`, name: n })),
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface SkipLogEntry {
  event: "linear.ticket_skipped";
  ticketId: string;
  identifier: string;
  reason: "missing_repo_label" | "ambiguous_repo_label" | "unknown_repo_slug";
  offendingSlug?: string;
}

function captureSkipLogs(): { entries: SkipLogEntry[]; restore: () => void } {
  const entries: SkipLogEntry[] = [];
  const original = console.warn;
  console.warn = (msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as Partial<SkipLogEntry>;
        if (parsed && parsed.event === "linear.ticket_skipped") {
          entries.push(parsed as SkipLogEntry);
          return;
        }
      } catch {
        // fall through to passthrough
      }
    }
    original(msg as never, ...(rest as never[]));
  };
  return {
    entries,
    restore: () => {
      console.warn = original;
    },
  };
}

function buildListActivity(): TemporalWorkerActivities["listAgentReadyTicketsActivity"] {
  // Wraps createLinearClient directly with TEST_REGISTRY so the resolver runs
  // against a deterministic registry (the production registry in build/repos.json
  // doesn't include "test-repo"). This still goes through `listAgentReadyTickets`
  // end-to-end — the boundary the spec requires the test to cover.
  return async () => {
    const client = createLinearClient({
      apiKey: "lin_test",
      teamId: "team_test",
      apiUrl: "https://linear.example/graphql",
      repoSlugs: TEST_REGISTRY,
    });
    return client.listAgentReadyTickets();
  };
}

function defaultPhaseActivities(): {
  runSpecPhase: (input: SpecPhaseInput) => Promise<SpecPhaseOutput>;
  runCoderPhase: (input: CoderPhaseInput) => Promise<CoderPhaseOutput>;
  runReviewPhase: (input: ReviewerInput) => Promise<{
    verdict: "approve";
    reasoning: string;
    findings: never[];
  }>;
} {
  return {
    runSpecPhase: async (input: SpecPhaseInput): Promise<SpecPhaseOutput> => ({
      featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
      testCommits: [
        {
          sha: "a".repeat(40),
          path: "server/tests/integration/sample.test.ts",
          description: `Failing acceptance tests for ${input.ticket.identifier}`,
        },
      ],
      implementationPlan: validImplementationPlan,
    }),
    runCoderPhase: async (input: CoderPhaseInput): Promise<CoderPhaseOutput> => ({
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
}

function buildOrchestratorActivities(opts: {
  phaseActivities: ReturnType<typeof defaultPhaseActivities>;
  launchCalls: LaunchWorkerContainerInput[];
}): TemporalWorkerActivities {
  return {
    ...opts.phaseActivities,
    helloActivity: async (n: string) => `hello, ${n}`,
    listAgentReadyTicketsActivity: buildListActivity(),
    syncLinearTicketStateActivity: async () => {},
    validateRepoSlug: async () => {},
    openPullRequestActivity: async () => ({
      number: 1,
      url: "https://github.test/example/pr/1",
    }),
    postPullRequestReviewActivity: async () => ({
      reviewId: 1,
      droppedComments: 0,
    }),
    launchWorkerContainer: async (
      input: LaunchWorkerContainerInput,
    ): Promise<LaunchWorkerContainerResult> => {
      opts.launchCalls.push(input);
      return {
        containerId: `stub-${input.attemptId}`,
        queue: taskQueueForRepo(input.repoSlug),
        logsPath: `/tmp/test-logs/${input.attemptId}`,
      };
    },
  };
}

describe("Linear → poller → per-ticket → launchWorkerContainer end-to-end", () => {
  installWorkflowCleanupHook();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("happy path: resolves repo:<slug> label, forwards description, and launches one container per phase", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-rr-happy-${randomUUID()}`;
    const stubbedDescription = "## Acceptance Criteria\n- ENG-RR1 must do the thing";
    const issueNode = makeIssueNode({
      id: `test-issue-${randomUUID()}`,
      identifier: "ENG-RR1",
      title: "Resolvable ticket",
      labelNames: ["agent-ready", `repo:${TEST_REPO_SLUG}`],
      description: stubbedDescription,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [issueNode],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const launchCalls: LaunchWorkerContainerInput[] = [];
    const phaseActivities = defaultPhaseActivities();
    const capturedSpecTickets: SpecPhaseInput["ticket"][] = [];
    const baseRunSpecPhase = phaseActivities.runSpecPhase;
    phaseActivities.runSpecPhase = async (input: SpecPhaseInput) => {
      capturedSpecTickets.push(input.ticket);
      return baseRunSpecPhase(input);
    };
    const activities = buildOrchestratorActivities({ phaseActivities, launchCalls });

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities, taskQueue: orchTaskQueue });
    const repoWorker = await createPerRepoWorker({
      taskQueue: taskQueueForRepo(TEST_REPO_SLUG),
      activities: phaseActivities,
    });

    await worker.runUntil(async () => {
      await repoWorker.runUntil(async () => {
        const handle = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
          args: [],
          taskQueue: orchTaskQueue,
          workflowId: `test-poller-${randomUUID()}`,
        });

        const result = await handle.result();
        expect(result.discovered).toBe(1);
        expect(result.started).toBe(1);
        expect(result.skipped).toBe(0);

        // The poller starts the per-ticket child with parentClosePolicy=ABANDON
        // and resolves once startChild ack returns — wait for the child to
        // actually finish so launchWorkerContainer has been invoked per phase.
        const ticketHandle = client.workflow.getHandle(buildPerTicketWorkflowId(issueNode.id));
        await expect(ticketHandle.result()).resolves.toEqual({
          status: "succeeded",
          pr: { number: 1, url: "https://github.test/example/pr/1" },
        });
      });
    });

    const phases = launchCalls.map((c) => c.phase);
    expect(phases).toEqual(["spec", "coder", "review"]);
    for (const call of launchCalls) {
      expect(call.repoSlug).toBe(TEST_REPO_SLUG);
      expect(call.ticketId).toBe(issueNode.id);
    }

    // The per-ticket workflow received the stubbed Linear description.
    expect(capturedSpecTickets).toHaveLength(1);
    expect(capturedSpecTickets[0].description).toBe(stubbedDescription);
  }, 60_000);

  it("missing_repo_label: ticket is skipped, no workflow starts, log entry emitted", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-rr-missing-${randomUUID()}`;
    const issueNode = makeIssueNode({
      id: `test-issue-${randomUUID()}`,
      identifier: "ENG-RR2",
      title: "Missing repo label",
      labelNames: ["agent-ready"],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [issueNode],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const skipLogs = captureSkipLogs();
    const launchCalls: LaunchWorkerContainerInput[] = [];
    const phaseActivities = defaultPhaseActivities();
    const activities = buildOrchestratorActivities({ phaseActivities, launchCalls });

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities, taskQueue: orchTaskQueue });

    try {
      await worker.runUntil(async () => {
        const handle = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
          args: [],
          taskQueue: orchTaskQueue,
          workflowId: `test-poller-${randomUUID()}`,
        });

        await expect(handle.result()).resolves.toEqual({
          discovered: 0,
          started: 0,
          skipped: 0,
        });
      });
    } finally {
      skipLogs.restore();
    }

    expect(launchCalls).toHaveLength(0);
    expect(skipLogs.entries).toHaveLength(1);
    expect(skipLogs.entries[0]).toMatchObject({
      event: "linear.ticket_skipped",
      ticketId: issueNode.id,
      identifier: "ENG-RR2",
      reason: "missing_repo_label",
    });
  }, 30_000);

  it("ambiguous_repo_label: multiple repo: labels are skipped", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-rr-ambig-${randomUUID()}`;
    const issueNode = makeIssueNode({
      id: `test-issue-${randomUUID()}`,
      identifier: "ENG-RR3",
      title: "Ambiguous repo labels",
      labelNames: ["agent-ready", `repo:${TEST_REPO_SLUG}`, "repo:other-repo"],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [issueNode],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const skipLogs = captureSkipLogs();
    const launchCalls: LaunchWorkerContainerInput[] = [];
    const phaseActivities = defaultPhaseActivities();
    const activities = buildOrchestratorActivities({ phaseActivities, launchCalls });

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities, taskQueue: orchTaskQueue });

    try {
      await worker.runUntil(async () => {
        const handle = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
          args: [],
          taskQueue: orchTaskQueue,
          workflowId: `test-poller-${randomUUID()}`,
        });

        await expect(handle.result()).resolves.toEqual({
          discovered: 0,
          started: 0,
          skipped: 0,
        });
      });
    } finally {
      skipLogs.restore();
    }

    expect(launchCalls).toHaveLength(0);
    expect(skipLogs.entries).toHaveLength(1);
    expect(skipLogs.entries[0]).toMatchObject({
      reason: "ambiguous_repo_label",
      identifier: "ENG-RR3",
    });
  }, 30_000);

  it("unknown_repo_slug: slug not in registry is skipped with offending slug captured", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-rr-unknown-${randomUUID()}`;
    const issueNode = makeIssueNode({
      id: `test-issue-${randomUUID()}`,
      identifier: "ENG-RR4",
      title: "Unknown slug",
      labelNames: ["agent-ready", "repo:no-such-repo"],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [issueNode],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const skipLogs = captureSkipLogs();
    const launchCalls: LaunchWorkerContainerInput[] = [];
    const phaseActivities = defaultPhaseActivities();
    const activities = buildOrchestratorActivities({ phaseActivities, launchCalls });

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities, taskQueue: orchTaskQueue });

    try {
      await worker.runUntil(async () => {
        const handle = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
          args: [],
          taskQueue: orchTaskQueue,
          workflowId: `test-poller-${randomUUID()}`,
        });

        await expect(handle.result()).resolves.toEqual({
          discovered: 0,
          started: 0,
          skipped: 0,
        });
      });
    } finally {
      skipLogs.restore();
    }

    expect(launchCalls).toHaveLength(0);
    expect(skipLogs.entries).toHaveLength(1);
    expect(skipLogs.entries[0]).toMatchObject({
      reason: "unknown_repo_slug",
      identifier: "ENG-RR4",
      offendingSlug: "no-such-repo",
    });
  }, 30_000);

  it("mixed batch: one resolvable + one ambiguous → exactly one workflow starts, one skip log emitted", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();

    const orchTaskQueue = `${TEMPORAL_TASK_QUEUE}-rr-mixed-${randomUUID()}`;
    const goodNode = makeIssueNode({
      id: `test-issue-${randomUUID()}`,
      identifier: "ENG-RR5",
      title: "Resolvable",
      labelNames: ["agent-ready", `repo:${TEST_REPO_SLUG}`],
    });
    const badNode = makeIssueNode({
      id: `test-issue-${randomUUID()}`,
      identifier: "ENG-RR6",
      title: "Ambiguous",
      labelNames: ["agent-ready", `repo:${TEST_REPO_SLUG}`, "repo:other"],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [goodNode, badNode],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    );

    const skipLogs = captureSkipLogs();
    const launchCalls: LaunchWorkerContainerInput[] = [];
    const phaseActivities = defaultPhaseActivities();
    const activities = buildOrchestratorActivities({ phaseActivities, launchCalls });

    const client = await createTemporalClient();
    const worker = await createTemporalWorker({ activities, taskQueue: orchTaskQueue });
    const repoWorker = await createPerRepoWorker({
      taskQueue: taskQueueForRepo(TEST_REPO_SLUG),
      activities: phaseActivities,
    });

    try {
      await worker.runUntil(async () => {
        await repoWorker.runUntil(async () => {
          const handle = await client.workflow.start(LINEAR_POLLER_WORKFLOW_NAME, {
            args: [],
            taskQueue: orchTaskQueue,
            workflowId: `test-poller-${randomUUID()}`,
          });

          const result = await handle.result();
          expect(result.discovered).toBe(1);
          expect(result.started).toBe(1);
          expect(result.skipped).toBe(0);

          const ticketHandle = client.workflow.getHandle(buildPerTicketWorkflowId(goodNode.id));
          await expect(ticketHandle.result()).resolves.toEqual({
            status: "succeeded",
            pr: { number: 1, url: "https://github.test/example/pr/1" },
          });
        });
      });
    } finally {
      skipLogs.restore();
    }

    // Only the good ticket triggered phase containers.
    expect(launchCalls.map((c) => c.phase)).toEqual(["spec", "coder", "review"]);
    for (const call of launchCalls) {
      expect(call.repoSlug).toBe(TEST_REPO_SLUG);
      expect(call.ticketId).toBe(goodNode.id);
    }

    // Exactly one skip log for the ambiguous ticket.
    expect(skipLogs.entries).toHaveLength(1);
    expect(skipLogs.entries[0]).toMatchObject({
      reason: "ambiguous_repo_label",
      identifier: "ENG-RR6",
    });
  }, 60_000);
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
