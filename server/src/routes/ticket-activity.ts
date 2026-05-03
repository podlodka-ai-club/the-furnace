import { Router, type Request, type Response } from "express";
import {
  TemporalUnavailableError,
  WorkflowNotFoundError,
  type TicketActivityService,
} from "../temporal/ticket-activity-service.js";
import type {
  ApiErrorBody,
  ListWorkflowsStatusFilter,
} from "../temporal/ticket-activity-types.js";

const STATUS_VALUES: ReadonlySet<ListWorkflowsStatusFilter> = new Set([
  "all",
  "running",
  "closed",
]);

const MAX_LIMIT = 200;

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createTicketActivityRouter(service: TicketActivityService): Router {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const status = parseStatus(req.query.status);
    const limit = parseLimit(req.query.limit);
    const workflows = await service.listWorkflows({ status, limit });
    res.status(200).json({ workflows });
  }));

  router.get("/:workflowId", asyncHandler(async (req, res) => {
    const workflowId = String(req.params.workflowId ?? "");
    if (!workflowId) {
      throw new HttpError(400, "workflowId path parameter is required", "invalid_workflow_id");
    }
    const runId = parseRunId(req.query.runId);
    const detail = await service.getWorkflowDetail(workflowId, runId);
    res.status(200).json(detail);
  }));

  router.use((err: unknown, _req: Request, res: Response, _next: (e?: unknown) => void) => {
    const { status, body } = mapError(err);
    res.status(status).json(body);
  });

  return router;
}

function parseStatus(raw: unknown): ListWorkflowsStatusFilter {
  if (raw === undefined) return "all";
  if (typeof raw !== "string") {
    throw new HttpError(400, "status must be a string", "invalid_status");
  }
  if (!STATUS_VALUES.has(raw as ListWorkflowsStatusFilter)) {
    throw new HttpError(
      400,
      `status must be one of: all, running, closed (got "${raw}")`,
      "invalid_status",
    );
  }
  return raw as ListWorkflowsStatusFilter;
}

function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(400, "limit must be a string integer", "invalid_limit");
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(400, "limit must be a positive integer", "invalid_limit");
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "limit must be a positive integer", "invalid_limit");
  }
  if (parsed > MAX_LIMIT) {
    throw new HttpError(400, `limit must be <= ${MAX_LIMIT}`, "invalid_limit");
  }
  return parsed;
}

function parseRunId(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HttpError(400, "runId must be a non-empty string", "invalid_run_id");
  }
  return raw;
}

function mapError(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { message: err.message, code: err.code } },
    };
  }
  if (err instanceof WorkflowNotFoundError) {
    return {
      status: 404,
      body: { error: { message: err.message, code: "workflow_not_found" } },
    };
  }
  if (err instanceof TemporalUnavailableError) {
    return {
      status: 503,
      body: { error: { message: err.message, code: "temporal_unavailable" } },
    };
  }
  const message = err instanceof Error ? err.message : "Internal Server Error";
  return {
    status: 500,
    body: { error: { message, code: "internal_error" } },
  };
}

type AsyncRouteHandler = (req: Request, res: Response) => Promise<void>;

function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    handler(req, res).catch(next);
  };
}
