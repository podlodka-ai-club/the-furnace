import { describe, it, expect, vi } from "vitest";
import {
  createTicketActivityService,
  TemporalUnavailableError,
  WorkflowNotFoundError,
} from "../../src/temporal/ticket-activity-service.js";

type ListResult = AsyncIterable<MockExec>;
interface MockExec {
  workflowId: string;
  runId: string;
  type: string;
  status: { name: string };
  startTime?: Date;
  closeTime?: Date;
}

function makeExec(overrides: Partial<MockExec>): MockExec {
  return {
    workflowId: "ticket-FUR-1",
    runId: "run-1",
    type: "perTicketWorkflow",
    status: { name: "RUNNING" },
    startTime: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function makeListClient(opts: {
  // First call (typed query) result.
  typedQuery?: { error?: Error; execs?: MockExec[] };
  // Fallback list-all call.
  scanAll?: MockExec[];
  // Throw on every list call (service-level outage).
  throwAll?: Error;
  describe?: () => Promise<unknown>;
  fetchHistory?: () => Promise<unknown>;
  query?: (name: string) => Promise<unknown>;
}) {
  const callsList: Array<{ query?: string }> = [];
  const callsHandle: string[] = [];
  const list = vi.fn((args?: { query?: string }): ListResult => {
    callsList.push({ query: args?.query });
    if (opts.throwAll) throw opts.throwAll;
    if (args?.query !== undefined) {
      if (opts.typedQuery?.error) throw opts.typedQuery.error;
      return iter(opts.typedQuery?.execs ?? []);
    }
    return iter(opts.scanAll ?? []);
  });
  const getHandle = vi.fn((workflowId: string, runId?: string) => {
    callsHandle.push(workflowId);
    return {
      workflowId,
      runId,
      describe: opts.describe ?? (async () => ({
        workflowId,
        runId: runId ?? "run-1",
        type: "perTicketWorkflow",
        status: { name: "RUNNING" },
        startTime: new Date(),
      })),
      fetchHistory: opts.fetchHistory ?? (async () => ({ events: [] })),
      query: opts.query ?? (async () => undefined),
    };
  });
  const client = {
    options: { namespace: "default" },
    workflow: { list, getHandle },
  };
  return { client: client as never, callsList, callsHandle };
}

describe("ticket-activity-service.listWorkflows", () => {
  it("returns summaries from the typed visibility query", async () => {
    const { client, callsList } = makeListClient({
      typedQuery: {
        execs: [makeExec({})],
      },
    });
    const svc = createTicketActivityService({ client });
    const result = await svc.listWorkflows({ status: "running" });
    expect(result).toHaveLength(1);
    expect(result[0].workflowId).toBe("ticket-FUR-1");
    expect(result[0].status).toBe("running");
    expect(callsList[0].query).toContain('WorkflowType="perTicketWorkflow"');
    expect(callsList[0].query).toContain('ExecutionStatus="Running"');
  });

  it("falls back to list-all + client filter on basic-visibility errors", async () => {
    const { client, callsList } = makeListClient({
      typedQuery: { error: new Error("InvalidArgument: search attribute not registered") },
      scanAll: [
        makeExec({ workflowId: "ticket-FUR-1" }),
        // Different workflow type — should be filtered out.
        makeExec({ workflowId: "linear-poller", type: "linearPollerWorkflow" }),
        makeExec({ workflowId: "ticket-FUR-2", runId: "run-2" }),
      ],
    });
    const svc = createTicketActivityService({ client });
    const result = await svc.listWorkflows();
    expect(result.map((r) => r.workflowId)).toEqual(["ticket-FUR-1", "ticket-FUR-2"]);
    // The first call attempts the typed visibility query, the fallback omits it.
    expect(callsList).toHaveLength(2);
    expect(callsList[0].query).toBeDefined();
    expect(callsList[1].query).toBeUndefined();
  });

  it("filters by status during fallback", async () => {
    const { client } = makeListClient({
      typedQuery: { error: new Error("InvalidArgument") },
      scanAll: [
        makeExec({ workflowId: "ticket-1", status: { name: "RUNNING" } }),
        makeExec({ workflowId: "ticket-2", status: { name: "COMPLETED" } }),
      ],
    });
    const svc = createTicketActivityService({ client });
    const running = await svc.listWorkflows({ status: "running" });
    const closed = await svc.listWorkflows({ status: "closed" });
    expect(running.map((r) => r.workflowId)).toEqual(["ticket-1"]);
    expect(closed.map((r) => r.workflowId)).toEqual(["ticket-2"]);
  });

  it("respects basic-visibility scan cap", async () => {
    // 600 unrelated workflows then one match — service should stop at the cap.
    const lots: MockExec[] = [];
    for (let i = 0; i < 600; i += 1) {
      lots.push(makeExec({ workflowId: `unrelated-${i}`, type: "linearPollerWorkflow" }));
    }
    lots.push(makeExec({ workflowId: "ticket-late" }));
    const { client } = makeListClient({
      typedQuery: { error: new Error("InvalidArgument") },
      scanAll: lots,
    });
    const svc = createTicketActivityService({ client, basicVisibilityScanCap: 100 });
    const result = await svc.listWorkflows();
    expect(result).toHaveLength(0);
  });

  it("translates UNAVAILABLE-shaped errors into TemporalUnavailableError", async () => {
    const { client } = makeListClient({
      throwAll: Object.assign(new Error("Unable to connect to Temporal at localhost:7233"), {
        name: "Error",
      }),
    });
    const svc = createTicketActivityService({ client });
    await expect(svc.listWorkflows()).rejects.toBeInstanceOf(TemporalUnavailableError);
  });
});

describe("ticket-activity-service.getWorkflowDetail", () => {
  it("returns an enriched detail with timeline + temporalWebUrl", async () => {
    const { client } = makeListClient({
      describe: async () => ({
        workflowId: "ticket-1",
        runId: "run-1",
        type: "perTicketWorkflow",
        status: { name: "COMPLETED" },
        startTime: new Date("2026-01-01T00:00:00Z"),
        closeTime: new Date("2026-01-01T00:10:00Z"),
      }),
      fetchHistory: async () => ({
        events: [
          {
            eventId: 1,
            eventType: 1,
            workflowExecutionStartedEventAttributes: {
              workflowType: { name: "perTicketWorkflow" },
            },
          },
          {
            eventId: 2,
            eventType: 2,
            workflowExecutionCompletedEventAttributes: {},
          },
        ],
      }),
      query: async (name) => {
        if (name === "currentPhase") return "completed";
        if (name === "attemptCount") return 1;
        if (name === "currentRound") return 0;
        return undefined;
      },
    });
    const svc = createTicketActivityService({
      client,
      temporalWebBase: "http://localhost:8233",
    });
    const detail = await svc.getWorkflowDetail("ticket-1");
    expect(detail.status).toBe("completed");
    expect(detail.phase).toBe("completed");
    expect(detail.attemptCount).toBe(1);
    expect(detail.currentRound).toBe(0);
    expect(detail.timeline.length).toBeGreaterThanOrEqual(1);
    expect(detail.temporalWebUrl).toContain("/namespaces/default/workflows/ticket-1");
  });

  it("omits temporalWebUrl when no base is configured", async () => {
    const { client } = makeListClient({});
    const svc = createTicketActivityService({ client, temporalWebBase: "" });
    const detail = await svc.getWorkflowDetail("ticket-1");
    expect(detail.temporalWebUrl).toBeUndefined();
  });

  it("translates NOT_FOUND into WorkflowNotFoundError", async () => {
    const grpcError = Object.assign(new Error("not found"), {
      code: 5,
      details: "",
      metadata: {},
      name: "ServiceError",
    });
    const client = {
      options: { namespace: "default" },
      workflow: {
        list: vi.fn(),
        getHandle: () => ({
          describe: async () => {
            throw grpcError;
          },
          fetchHistory: async () => ({ events: [] }),
          query: async () => undefined,
        }),
      },
    };
    const svc = createTicketActivityService({ client: client as never });
    await expect(svc.getWorkflowDetail("ticket-x")).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
});
