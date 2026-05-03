import type {
  ListWorkflowsParams,
  TicketWorkflowDetail,
  TicketWorkflowSummary,
} from "../../src/temporal/ticket-activity-types.js";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const message =
      isErrorBody(body) && typeof body.error.message === "string"
        ? body.error.message
        : `Request failed with status ${res.status}`;
    const code = isErrorBody(body) ? body.error.code : undefined;
    throw new ApiError(res.status, message, code);
  }
  return body as T;
}

function isErrorBody(body: unknown): body is { error: { message?: string; code?: string } } {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "object" &&
    (body as { error: unknown }).error !== null
  );
}

export async function listTicketWorkflows(
  params: ListWorkflowsParams = {},
): Promise<TicketWorkflowSummary[]> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  const url = qs ? `/api/ticket-workflows?${qs}` : "/api/ticket-workflows";
  const result = await request<{ workflows: TicketWorkflowSummary[] }>(url);
  return result.workflows;
}

export async function getTicketWorkflow(
  workflowId: string,
  runId?: string,
): Promise<TicketWorkflowDetail> {
  const search = new URLSearchParams();
  if (runId) search.set("runId", runId);
  const qs = search.toString();
  const path = `/api/ticket-workflows/${encodeURIComponent(workflowId)}${qs ? `?${qs}` : ""}`;
  return await request<TicketWorkflowDetail>(path);
}
