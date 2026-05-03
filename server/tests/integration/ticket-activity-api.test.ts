import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import {
  TemporalUnavailableError,
  WorkflowNotFoundError,
  type TicketActivityService,
} from "../../src/temporal/ticket-activity-service.js";
import type {
  TicketWorkflowDetail,
  TicketWorkflowSummary,
} from "../../src/temporal/ticket-activity-types.js";

function makeService(overrides: Partial<TicketActivityService> = {}): TicketActivityService {
  return {
    listWorkflows: async () => [],
    getWorkflowDetail: async () => {
      throw new Error("not configured");
    },
    ...overrides,
  };
}

async function buildApp(svc: TicketActivityService) {
  return createApp({
    ticketActivityService: svc,
    skipUi: true,
  });
}

const baseSummary: TicketWorkflowSummary = {
  workflowId: "ticket-FUR-1",
  runId: "run-1",
  status: "running",
  ticketIdentifier: "FUR-1",
  title: "Add login flow",
};

const baseDetail: TicketWorkflowDetail = {
  ...baseSummary,
  timeline: [
    {
      id: "evt-1",
      eventId: 1,
      type: "workflow-execution-started",
      label: "Workflow started",
      status: "running",
      category: "workflow",
    },
  ],
  reviewRounds: [],
  humanPauses: [],
};

describe("GET /api/ticket-workflows", () => {
  it("returns the list with default filters", async () => {
    const svc = makeService({
      listWorkflows: async (params) => {
        expect(params).toEqual({ status: "all", limit: undefined });
        return [baseSummary];
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workflows: [baseSummary] });
  });

  it("forwards status and limit query params", async () => {
    let captured: unknown;
    const svc = makeService({
      listWorkflows: async (params) => {
        captured = params;
        return [];
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows?status=closed&limit=10");
    expect(res.status).toBe(200);
    expect(captured).toEqual({ status: "closed", limit: 10 });
  });

  it("rejects an invalid status with 400", async () => {
    const app = await buildApp(makeService());
    const res = await request(app).get("/api/ticket-workflows?status=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_status");
  });

  it("rejects a non-numeric limit with 400", async () => {
    const app = await buildApp(makeService());
    const res = await request(app).get("/api/ticket-workflows?limit=abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_limit");
  });

  it("rejects a limit larger than the cap", async () => {
    const app = await buildApp(makeService());
    const res = await request(app).get("/api/ticket-workflows?limit=99999");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_limit");
  });

  it("returns 503 when Temporal is unavailable", async () => {
    const svc = makeService({
      listWorkflows: async () => {
        throw new TemporalUnavailableError("temporal down");
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("temporal_unavailable");
  });
});

describe("GET /api/ticket-workflows/:workflowId", () => {
  it("returns the workflow detail", async () => {
    const svc = makeService({
      getWorkflowDetail: async (id, runId) => {
        expect(id).toBe("ticket-FUR-1");
        expect(runId).toBeUndefined();
        return baseDetail;
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows/ticket-FUR-1");
    expect(res.status).toBe(200);
    expect(res.body.workflowId).toBe("ticket-FUR-1");
    expect(res.body.timeline).toHaveLength(1);
  });

  it("forwards optional runId query param", async () => {
    let captured: { id: string; runId?: string } = { id: "" };
    const svc = makeService({
      getWorkflowDetail: async (id, runId) => {
        captured = { id, runId };
        return baseDetail;
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows/ticket-FUR-1?runId=run-2");
    expect(res.status).toBe(200);
    expect(captured).toEqual({ id: "ticket-FUR-1", runId: "run-2" });
  });

  it("returns 404 when the workflow is missing", async () => {
    const svc = makeService({
      getWorkflowDetail: async () => {
        throw new WorkflowNotFoundError("ticket-x");
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows/ticket-x");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("workflow_not_found");
  });

  it("returns 503 when Temporal is unavailable", async () => {
    const svc = makeService({
      getWorkflowDetail: async () => {
        throw new TemporalUnavailableError("temporal down");
      },
    });
    const app = await buildApp(svc);
    const res = await request(app).get("/api/ticket-workflows/ticket-1");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("temporal_unavailable");
  });

  it("rejects empty runId with 400", async () => {
    const app = await buildApp(makeService());
    const res = await request(app).get("/api/ticket-workflows/ticket-1?runId=");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_run_id");
  });
});

describe("/health remains intact alongside ticket activity routes", () => {
  it("returns 200 ok with uptimeMs", async () => {
    const app = await buildApp(makeService());
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(Number.isInteger(res.body.uptimeMs)).toBe(true);
  });
});
