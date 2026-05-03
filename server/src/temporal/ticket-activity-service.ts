import type { Client, WorkflowExecutionInfo } from "@temporalio/client";
import { isGrpcServiceError } from "@temporalio/client";
import type {
  ListWorkflowsParams,
  TicketWorkflowDetail,
  TicketWorkflowSummary,
  WorkflowStatus,
} from "./ticket-activity-types.js";
import {
  buildTemporalWebUrl,
  buildTimeline,
  decodePullRequestFromHistory,
  extractHumanPauses,
  groupReviewRounds,
  normalizeAttemptCount,
  normalizeCurrentRound,
  normalizePhase,
  normalizeWorkflowStatus,
  workflowFailureToTerminal,
  type DecodedHistoryEvent,
  type DecodedWorkflowResult,
  type DecodedWorkflowStartInput,
} from "./ticket-activity-normalize.js";
import { decodeHistory } from "./ticket-activity-history-decoder.js";

export const PER_TICKET_WORKFLOW_TYPE = "perTicketWorkflow";

// Conservative cap when falling back to scan-all listing on basic-visibility
// clusters. Filtering happens client-side, so this bounds the work we do
// while still returning enough results to populate the dashboard.
export const BASIC_VISIBILITY_SCAN_CAP = 500;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export class TemporalUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TemporalUnavailableError";
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string, runId?: string) {
    super(
      runId
        ? `Workflow ${workflowId} run ${runId} not found`
        : `Workflow ${workflowId} not found`,
    );
    this.name = "WorkflowNotFoundError";
  }
}

export interface ListWorkflowsOptions extends ListWorkflowsParams {}

export interface TicketActivityService {
  listWorkflows(options?: ListWorkflowsOptions): Promise<TicketWorkflowSummary[]>;
  getWorkflowDetail(workflowId: string, runId?: string): Promise<TicketWorkflowDetail>;
}

export interface CreateTicketActivityServiceOptions {
  client: Client;
  // Optional override of the namespace embedded in Temporal Web deep links.
  namespace?: string;
  // Optional override of the Temporal Web base URL. If undefined or empty,
  // detail responses omit `temporalWebUrl`.
  temporalWebBase?: string;
  // Override the basic-visibility scan cap (mostly for tests).
  basicVisibilityScanCap?: number;
}

export function createTicketActivityService(
  options: CreateTicketActivityServiceOptions,
): TicketActivityService {
  const { client, namespace, temporalWebBase, basicVisibilityScanCap } = options;
  const scanCap = basicVisibilityScanCap ?? BASIC_VISIBILITY_SCAN_CAP;
  const ns = namespace ?? client.options.namespace;

  return {
    async listWorkflows(opts = {}) {
      const limit = clampLimit(opts.limit);
      const status = opts.status ?? "all";
      const executions = await listExecutions(client, status, limit, scanCap);
      const summaries: TicketWorkflowSummary[] = [];
      for (const exec of executions) {
        try {
          summaries.push(await buildSummary(client, exec));
        } catch (err) {
          if (isUnavailable(err)) {
            throw new TemporalUnavailableError(
              "Temporal unavailable while building workflow summary",
              { cause: err },
            );
          }
          // Per spec: query failures must NOT hide the workflow. Surface a
          // minimal summary that still includes identity + status.
          summaries.push(buildMinimalSummary(exec));
        }
      }
      return summaries;
    },

    async getWorkflowDetail(workflowId, runId) {
      try {
        const handle = client.workflow.getHandle(workflowId, runId);
        const description = await handle.describe();
        const history = await handle.fetchHistory();
        const events = decodeHistory(history);
        const summary = await buildSummaryFromDescription(client, description, events);
        const reviewRounds = groupReviewRounds(events);
        const terminalEvent = events.find(
          (e) =>
            e.type === "workflow-execution-failed" ||
            e.type === "workflow-execution-canceled" ||
            e.type === "workflow-execution-timed-out",
        );
        const terminalFailure = workflowFailureToTerminal(
          terminalEvent?.failure,
          terminalEvent?.timestamp,
        );
        const humanPauses = extractHumanPauses(events, terminalEvent?.failure);
        const detail: TicketWorkflowDetail = {
          ...summary,
          terminalFailure,
          timeline: buildTimeline(events),
          reviewRounds,
          humanPauses,
        };
        const url = buildTemporalWebUrl(temporalWebBase, ns, workflowId, summary.runId);
        if (url) detail.temporalWebUrl = url;
        return detail;
      } catch (err) {
        if (isNotFound(err)) {
          throw new WorkflowNotFoundError(workflowId, runId);
        }
        if (isUnavailable(err)) {
          throw new TemporalUnavailableError(
            "Temporal unavailable while fetching workflow detail",
            { cause: err },
          );
        }
        throw err;
      }
    },
  };
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(value, MAX_LIST_LIMIT);
}

async function listExecutions(
  client: Client,
  status: ListWorkflowsParams["status"],
  limit: number,
  scanCap: number,
): Promise<WorkflowExecutionInfo[]> {
  const baseQuery = `WorkflowType="${PER_TICKET_WORKFLOW_TYPE}"`;
  const filterQuery = applyStatusFilter(baseQuery, status);
  try {
    return await collectExecutions(client.workflow.list({ query: filterQuery }), limit);
  } catch (err) {
    if (!isVisibilityQueryUnsupported(err)) {
      if (isUnavailable(err)) {
        throw new TemporalUnavailableError("Temporal unavailable while listing workflows", {
          cause: err,
        });
      }
      throw err;
    }
    // Basic-visibility fallback: list everything and filter client-side.
    return await collectExecutionsWithClientFilter(client, status, limit, scanCap);
  }
}

function applyStatusFilter(base: string, status: ListWorkflowsParams["status"]): string {
  if (!status || status === "all") return base;
  if (status === "running") return `${base} AND ExecutionStatus="Running"`;
  if (status === "closed") return `${base} AND ExecutionStatus!="Running"`;
  return base;
}

async function collectExecutions(
  iter: AsyncIterable<WorkflowExecutionInfo>,
  limit: number,
): Promise<WorkflowExecutionInfo[]> {
  const out: WorkflowExecutionInfo[] = [];
  for await (const exec of iter) {
    out.push(exec);
    if (out.length >= limit) break;
  }
  return out;
}

async function collectExecutionsWithClientFilter(
  client: Client,
  status: ListWorkflowsParams["status"],
  limit: number,
  scanCap: number,
): Promise<WorkflowExecutionInfo[]> {
  const out: WorkflowExecutionInfo[] = [];
  let scanned = 0;
  try {
    for await (const exec of client.workflow.list()) {
      scanned += 1;
      if (exec.type !== PER_TICKET_WORKFLOW_TYPE) {
        if (scanned >= scanCap) break;
        continue;
      }
      if (!matchesStatus(exec, status)) {
        if (scanned >= scanCap) break;
        continue;
      }
      out.push(exec);
      if (out.length >= limit) break;
      if (scanned >= scanCap) break;
    }
  } catch (err) {
    if (isUnavailable(err)) {
      throw new TemporalUnavailableError("Temporal unavailable during fallback listing", {
        cause: err,
      });
    }
    throw err;
  }
  return out;
}

function matchesStatus(exec: WorkflowExecutionInfo, status: ListWorkflowsParams["status"]): boolean {
  if (!status || status === "all") return true;
  const s = normalizeWorkflowStatus(exec.status?.name);
  if (status === "running") return s === "running";
  if (status === "closed") return s !== "running";
  return true;
}

async function buildSummary(
  client: Client,
  exec: WorkflowExecutionInfo,
): Promise<TicketWorkflowSummary> {
  const handle = client.workflow.getHandle(exec.workflowId, exec.runId);
  const phase = await tryQuery<unknown>(handle, "currentPhase");
  const attemptCount = await tryQuery<unknown>(handle, "attemptCount");
  const currentRound = await tryQuery<unknown>(handle, "currentRound");
  const summary: TicketWorkflowSummary = baseSummaryFromExec(exec);
  const normalizedPhase = normalizePhase(phase);
  if (normalizedPhase) summary.phase = normalizedPhase;
  const normAttempt = normalizeAttemptCount(attemptCount);
  if (normAttempt !== undefined) summary.attemptCount = normAttempt;
  const normRound = normalizeCurrentRound(currentRound);
  if (normRound !== undefined) summary.currentRound = normRound;
  // Best-effort enrichment from history (start input + open-PR completion).
  await enrichFromHistory(handle, summary);
  return summary;
}

async function buildSummaryFromDescription(
  client: Client,
  description: { workflowId: string; runId: string; status: { name: string }; type: string; startTime?: Date; closeTime?: Date },
  events: DecodedHistoryEvent[],
): Promise<TicketWorkflowSummary> {
  const summary = baseSummaryFromExec(description as unknown as WorkflowExecutionInfo);
  const handle = client.workflow.getHandle(description.workflowId, description.runId);
  const phase = await tryQuery<unknown>(handle, "currentPhase");
  const attemptCount = await tryQuery<unknown>(handle, "attemptCount");
  const currentRound = await tryQuery<unknown>(handle, "currentRound");
  const normalizedPhase = normalizePhase(phase);
  if (normalizedPhase) summary.phase = normalizedPhase;
  const normAttempt = normalizeAttemptCount(attemptCount);
  if (normAttempt !== undefined) summary.attemptCount = normAttempt;
  const normRound = normalizeCurrentRound(currentRound);
  if (normRound !== undefined) summary.currentRound = normRound;

  const startInput = extractWorkflowStartInput(events);
  if (startInput) {
    if (startInput.ticket?.id) summary.ticketId = startInput.ticket.id;
    if (startInput.ticket?.identifier) summary.ticketIdentifier = startInput.ticket.identifier;
    if (startInput.ticket?.title) summary.title = startInput.ticket.title;
    if (startInput.targetRepoSlug) summary.targetRepoSlug = startInput.targetRepoSlug;
  }

  const completionResult = extractWorkflowCompletionResult(events);
  if (completionResult?.pr) {
    summary.pr = completionResult.pr;
  } else {
    const decodedPr = decodePullRequestFromHistory(events);
    if (decodedPr) summary.pr = decodedPr;
  }

  return summary;
}

async function enrichFromHistory(
  handle: { fetchHistory: () => Promise<unknown> },
  summary: TicketWorkflowSummary,
): Promise<void> {
  try {
    const history = (await handle.fetchHistory()) as Parameters<typeof decodeHistory>[0];
    const events = decodeHistory(history);
    const startInput = extractWorkflowStartInput(events);
    if (startInput) {
      if (!summary.ticketId && startInput.ticket?.id) summary.ticketId = startInput.ticket.id;
      if (!summary.ticketIdentifier && startInput.ticket?.identifier) {
        summary.ticketIdentifier = startInput.ticket.identifier;
      }
      if (!summary.title && startInput.ticket?.title) summary.title = startInput.ticket.title;
      if (!summary.targetRepoSlug && startInput.targetRepoSlug) {
        summary.targetRepoSlug = startInput.targetRepoSlug;
      }
    }
    if (!summary.pr) {
      const completionResult = extractWorkflowCompletionResult(events);
      if (completionResult?.pr) {
        summary.pr = completionResult.pr;
      } else {
        const decodedPr = decodePullRequestFromHistory(events);
        if (decodedPr) summary.pr = decodedPr;
      }
    }
  } catch {
    // Swallow history enrichment failures so summary list-row stays stable.
  }
}

function baseSummaryFromExec(exec: WorkflowExecutionInfo): TicketWorkflowSummary {
  return {
    workflowId: exec.workflowId,
    runId: exec.runId,
    status: normalizeWorkflowStatus(exec.status?.name),
    startedAt: exec.startTime ? exec.startTime.toISOString() : undefined,
    closedAt: exec.closeTime ? exec.closeTime.toISOString() : undefined,
  };
}

function buildMinimalSummary(exec: WorkflowExecutionInfo): TicketWorkflowSummary {
  return baseSummaryFromExec(exec);
}

function extractWorkflowStartInput(
  events: DecodedHistoryEvent[],
): DecodedWorkflowStartInput | undefined {
  for (const ev of events) {
    if (ev.type === "workflow-execution-started") {
      const input = ev.input;
      if (Array.isArray(input)) {
        const first = input[0];
        if (first && typeof first === "object") return first as DecodedWorkflowStartInput;
      } else if (input && typeof input === "object") {
        return input as DecodedWorkflowStartInput;
      }
      return undefined;
    }
  }
  return undefined;
}

function extractWorkflowCompletionResult(
  events: DecodedHistoryEvent[],
): DecodedWorkflowResult | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "workflow-execution-completed") {
      const out = events[i].output;
      if (out && typeof out === "object" && !Array.isArray(out)) {
        return out as DecodedWorkflowResult;
      }
      return undefined;
    }
  }
  return undefined;
}

const QUERY_TIMEOUT_MS = 1500;

async function tryQuery<T>(
  handle: { query: (name: string) => Promise<T> },
  name: string,
): Promise<T | undefined> {
  try {
    return await withTimeout(handle.query(name), QUERY_TIMEOUT_MS);
  } catch (err) {
    if (isUnavailable(err)) {
      // Re-throw connection-level failures; let caller convert to 503.
      throw err;
    }
    // Timeout, query-not-registered, or workflow-without-worker: surface as
    // missing data rather than blocking the dashboard.
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`query timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function isUnavailable(err: unknown): boolean {
  if (isGrpcServiceError(err)) {
    const code = (err as unknown as { code?: number }).code;
    // gRPC UNAVAILABLE = 14, DEADLINE_EXCEEDED = 4. Both indicate the cluster
    // is unreachable from the operator's perspective.
    return code === 14 || code === 4;
  }
  // Connection layer wraps connect failures in a plain Error.
  if (err instanceof Error && /Unable to connect to Temporal/i.test(err.message)) {
    return true;
  }
  return false;
}

export function isNotFound(err: unknown): boolean {
  if (isGrpcServiceError(err)) {
    const code = (err as unknown as { code?: number }).code;
    return code === 5; // NOT_FOUND
  }
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: string }).name;
    if (name === "WorkflowNotFoundError") return true;
  }
  return false;
}

function isVisibilityQueryUnsupported(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  // The local development Temporal cluster (basic visibility) responds with
  // INVALID_ARGUMENT and a "search attribute" error when given the typed
  // visibility query.
  return /InvalidArgument|search attribute|advanced visibility/i.test(message);
}
