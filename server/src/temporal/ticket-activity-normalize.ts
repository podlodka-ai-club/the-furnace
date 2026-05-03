import type {
  HumanPause,
  HumanPauseFailureType,
  HumanPauseType,
  PullRequestRef,
  ReviewRoundSummary,
  ReviewSummary,
  SubTicketRef,
  TerminalFailure,
  TimelineEvent,
  TimelineEventCategory,
  TimelineEventStatus,
  WorkflowFailure,
  WorkflowPhase,
  WorkflowStatus,
} from "./ticket-activity-types.js";

// Decoded representation of a Temporal history event. Created by
// `temporal-history-decoder.ts` from proto IHistoryEvent. Pure JS so
// normalization tests can build fixtures without proto types.
export interface DecodedHistoryEvent {
  eventId: number;
  timestamp?: string;
  type: DecodedEventType;
  // Common fields by type. Optional everywhere — defensive decoding is the
  // contract. Unknown event types fall through with `type: "unknown"` and
  // the original numeric event type / event-attributes key set as `rawType`.
  rawType?: string;
  // Activity scheduled/started/completed/failed/cancel-requested/canceled all
  // share an activity reference.
  activityType?: string;
  activityId?: string;
  scheduledEventId?: number;
  // Activity completion result/input as decoded JSON-friendly value.
  input?: unknown;
  output?: unknown;
  // Activity failure chain (decoded from proto Failure tree).
  failure?: DecodedFailure;
  // Workflow signal name (signal events).
  signalName?: string;
  // For workflow-execution-started events.
  workflowType?: string;
}

export type DecodedEventType =
  | "workflow-execution-started"
  | "workflow-execution-completed"
  | "workflow-execution-failed"
  | "workflow-execution-canceled"
  | "workflow-execution-cancel-requested"
  | "workflow-execution-terminated"
  | "workflow-execution-timed-out"
  | "workflow-execution-signaled"
  | "activity-task-scheduled"
  | "activity-task-started"
  | "activity-task-completed"
  | "activity-task-failed"
  | "activity-task-cancel-requested"
  | "activity-task-canceled"
  | "activity-task-timed-out"
  | "marker-recorded"
  | "workflow-task-failed"
  | "unknown";

export interface DecodedFailure {
  message?: string;
  // ApplicationFailure type (e.g. "AcClarificationRequested"), if present.
  failureType?: string;
  nonRetryable?: boolean;
  details?: unknown[];
  cause?: DecodedFailure;
}

// Inputs to the workflow's perTicketWorkflow start event.
export interface DecodedWorkflowStartInput {
  ticket?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
  };
  targetRepoSlug?: string;
}

// Result of perTicketWorkflow when it completes successfully.
export interface DecodedWorkflowResult {
  status?: "succeeded" | "cancelled";
  pr?: PullRequestRef;
}

// Result of openPullRequestActivity.
export interface DecodedOpenPullRequestResult {
  number?: number;
  url?: string;
}

const KNOWN_PHASE_ACTIVITIES = new Set([
  "runSpecPhase",
  "runCoderPhase",
  "runReviewPhase",
]);

const KNOWN_GITHUB_ACTIVITIES = new Set([
  "openPullRequestActivity",
  "postPullRequestReviewActivity",
]);

const KNOWN_LINEAR_ACTIVITIES = new Set([
  "syncLinearTicketStateActivity",
  "listAgentReadyTicketsActivity",
]);

const KNOWN_CONTAINER_ACTIVITIES = new Set([
  "launchWorkerContainer",
  "validateRepoSlug",
]);

const HUMAN_PAUSE_FAILURE_TYPES: Record<HumanPauseFailureType, HumanPauseType> = {
  AcClarificationRequested: "ac-clarification",
  DepMissingRequested: "dep-missing",
  DesignQuestionRequested: "design-question",
  ReviewRoundCapExhausted: "review-round-cap",
};

export function categorizeActivity(activityType?: string): TimelineEventCategory {
  if (!activityType) return "other";
  if (activityType === "runSpecPhase") return "spec";
  if (activityType === "runCoderPhase") return "coder";
  if (activityType === "runReviewPhase") return "review";
  if (KNOWN_GITHUB_ACTIVITIES.has(activityType)) return "github";
  if (KNOWN_LINEAR_ACTIVITIES.has(activityType)) return "linear";
  if (KNOWN_CONTAINER_ACTIVITIES.has(activityType)) return "container";
  return "other";
}

function activityLabel(activityType: string): string {
  switch (activityType) {
    case "runSpecPhase":
      return "Spec phase";
    case "runCoderPhase":
      return "Coder phase";
    case "runReviewPhase":
      return "Review phase";
    case "openPullRequestActivity":
      return "Open pull request";
    case "postPullRequestReviewActivity":
      return "Post pull request review";
    case "syncLinearTicketStateActivity":
      return "Sync Linear ticket state";
    case "listAgentReadyTicketsActivity":
      return "List agent-ready tickets";
    case "launchWorkerContainer":
      return "Launch worker container";
    case "validateRepoSlug":
      return "Validate repo slug";
    default:
      return activityType;
  }
}

// Convert Temporal status name to our normalized WorkflowStatus.
export function normalizeWorkflowStatus(name: string | undefined): WorkflowStatus {
  switch ((name ?? "").toUpperCase()) {
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    case "TERMINATED":
      return "terminated";
    case "TIMED_OUT":
      return "timed_out";
    default:
      return "unknown";
  }
}

export function normalizePhase(value: unknown): WorkflowPhase | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "queued":
    case "spec":
    case "coder":
    case "review":
    case "completed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function normalizeAttemptCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function normalizeCurrentRound(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

// Build the chronological timeline. Tracks pending activities so completion
// events can be paired and unknown events still appear with their event id.
export function buildTimeline(events: DecodedHistoryEvent[]): TimelineEvent[] {
  // Track activity scheduling so we can coalesce schedule + start + end into
  // a single timeline entry whose status reflects the latest known state.
  type Pending = { event: TimelineEvent; activityType: string };
  const pendingByScheduled = new Map<number, Pending>();
  const result: TimelineEvent[] = [];

  for (const ev of events) {
    if (ev.type === "activity-task-scheduled" && ev.activityType) {
      const item: TimelineEvent = {
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: ev.activityType,
        label: activityLabel(ev.activityType),
        status: "pending",
        category: categorizeActivity(ev.activityType),
      };
      result.push(item);
      pendingByScheduled.set(ev.eventId, { event: item, activityType: ev.activityType });
      continue;
    }
    if (ev.type === "activity-task-started" && ev.scheduledEventId !== undefined) {
      const pending = pendingByScheduled.get(ev.scheduledEventId);
      if (pending) {
        pending.event.status = "running";
        continue;
      }
    }
    if (ev.type === "activity-task-completed" && ev.scheduledEventId !== undefined) {
      const pending = pendingByScheduled.get(ev.scheduledEventId);
      if (pending) {
        pending.event.status = "completed";
        pending.event.timestamp = ev.timestamp ?? pending.event.timestamp;
        if (ev.output !== undefined) {
          pending.event.details = { ...(pending.event.details ?? {}), output: ev.output };
        }
        continue;
      }
    }
    if (ev.type === "activity-task-failed" && ev.scheduledEventId !== undefined) {
      const pending = pendingByScheduled.get(ev.scheduledEventId);
      if (pending) {
        pending.event.status = "failed";
        pending.event.timestamp = ev.timestamp ?? pending.event.timestamp;
        if (ev.failure) {
          pending.event.details = { ...(pending.event.details ?? {}), failure: ev.failure };
        }
        continue;
      }
    }
    if (
      (ev.type === "activity-task-canceled" || ev.type === "activity-task-cancel-requested") &&
      ev.scheduledEventId !== undefined
    ) {
      const pending = pendingByScheduled.get(ev.scheduledEventId);
      if (pending) {
        pending.event.status = "cancelled";
        continue;
      }
    }
    if (ev.type === "activity-task-timed-out" && ev.scheduledEventId !== undefined) {
      const pending = pendingByScheduled.get(ev.scheduledEventId);
      if (pending) {
        pending.event.status = "failed";
        if (ev.failure) {
          pending.event.details = { ...(pending.event.details ?? {}), failure: ev.failure };
        }
        continue;
      }
    }
    if (ev.type === "workflow-execution-started") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-started",
        label: ev.workflowType ? `Workflow started: ${ev.workflowType}` : "Workflow started",
        status: "running",
        category: "workflow",
      });
      continue;
    }
    if (ev.type === "workflow-execution-completed") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-completed",
        label: "Workflow completed",
        status: "completed",
        category: "workflow",
      });
      continue;
    }
    if (ev.type === "workflow-execution-failed") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-failed",
        label: ev.failure?.failureType
          ? `Workflow failed (${ev.failure.failureType})`
          : "Workflow failed",
        status: "failed",
        category: "workflow",
        details: ev.failure ? { failure: ev.failure } : undefined,
      });
      continue;
    }
    if (ev.type === "workflow-execution-canceled") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-canceled",
        label: "Workflow canceled",
        status: "cancelled",
        category: "workflow",
      });
      continue;
    }
    if (ev.type === "workflow-execution-cancel-requested") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-cancel-requested",
        label: "Cancel requested",
        status: "cancelled",
        category: "signal",
      });
      continue;
    }
    if (ev.type === "workflow-execution-terminated") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-terminated",
        label: "Workflow terminated",
        status: "cancelled",
        category: "workflow",
      });
      continue;
    }
    if (ev.type === "workflow-execution-timed-out") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-timed-out",
        label: "Workflow timed out",
        status: "failed",
        category: "workflow",
      });
      continue;
    }
    if (ev.type === "workflow-execution-signaled") {
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-execution-signaled",
        label: ev.signalName ? `Signal: ${ev.signalName}` : "Workflow signaled",
        status: "completed",
        category: "signal",
      });
      continue;
    }
    if (ev.type === "marker-recorded") {
      // Markers are workflow-internal (e.g., side effects). Render generically.
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "marker-recorded",
        label: "Marker",
        status: "completed",
        category: "other",
      });
      continue;
    }
    if (ev.type === "workflow-task-failed") {
      // Workflow-task failures are usually transient; still surface them.
      result.push({
        id: `evt-${ev.eventId}`,
        eventId: ev.eventId,
        timestamp: ev.timestamp,
        type: "workflow-task-failed",
        label: "Workflow task failed",
        status: "failed",
        category: "workflow",
        details: ev.failure ? { failure: ev.failure } : undefined,
      });
      continue;
    }
    // Unknown event types remain visible so we never silently drop history.
    result.push({
      id: `evt-${ev.eventId}`,
      eventId: ev.eventId,
      timestamp: ev.timestamp,
      type: ev.rawType ?? "unknown",
      label: ev.rawType ?? "Unknown event",
      status: "unknown",
      category: "other",
    });
  }
  return result;
}

// Find the most recent completed openPullRequestActivity in the event stream
// and return its decoded result if it looks like a PR ref.
export function decodePullRequestFromHistory(
  events: DecodedHistoryEvent[],
): PullRequestRef | undefined {
  // Map scheduledEventId -> activityType for openPullRequestActivity.
  const openPrScheduledIds = new Set<number>();
  for (const ev of events) {
    if (ev.type === "activity-task-scheduled" && ev.activityType === "openPullRequestActivity") {
      openPrScheduledIds.add(ev.eventId);
    }
  }
  // Walk in reverse so the latest completion wins.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (
      ev.type === "activity-task-completed" &&
      ev.scheduledEventId !== undefined &&
      openPrScheduledIds.has(ev.scheduledEventId)
    ) {
      const decoded = ev.output as DecodedOpenPullRequestResult | undefined;
      if (
        decoded &&
        typeof decoded.number === "number" &&
        typeof decoded.url === "string" &&
        decoded.url.length > 0
      ) {
        return { number: decoded.number, url: decoded.url };
      }
    }
  }
  return undefined;
}

// Walk the failure chain looking for a known human-pause type. Returns the
// matching pause, or undefined if no known type is found.
export function failureToHumanPause(
  failure: DecodedFailure | undefined,
  occurredAt?: string,
): HumanPause | undefined {
  if (!failure) return undefined;
  let current: DecodedFailure | undefined = failure;
  while (current) {
    const type = current.failureType;
    if (type && type in HUMAN_PAUSE_FAILURE_TYPES) {
      const pauseType = HUMAN_PAUSE_FAILURE_TYPES[type as HumanPauseFailureType];
      const detail = pickFailureDetail(current.details);
      return {
        type: pauseType,
        failureType: type as HumanPauseFailureType,
        message: current.message,
        subTicket: extractSubTicket(detail),
        review: extractReviewSummary(detail),
        occurredAt,
      };
    }
    current = current.cause;
  }
  return undefined;
}

function pickFailureDetail(details: unknown[] | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(details)) return undefined;
  const first = details[0];
  if (first && typeof first === "object") {
    return first as Record<string, unknown>;
  }
  return undefined;
}

function extractSubTicket(detail: Record<string, unknown> | undefined): SubTicketRef | undefined {
  if (!detail) return undefined;
  const candidate = (detail.subTicket ?? detail.subTicketRef) as
    | Record<string, unknown>
    | undefined;
  if (candidate && typeof candidate === "object") {
    return {
      id: typeof candidate.id === "string" ? candidate.id : undefined,
      identifier: typeof candidate.identifier === "string" ? candidate.identifier : undefined,
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    };
  }
  return undefined;
}

function extractReviewSummary(detail: Record<string, unknown> | undefined): ReviewSummary | undefined {
  if (!detail) return undefined;
  const findings = Array.isArray(detail.findings) ? detail.findings : undefined;
  const review: ReviewSummary = {};
  if (typeof detail.verdict === "string") review.verdict = detail.verdict;
  if (typeof detail.reasoning === "string") review.reasoning = detail.reasoning;
  if (findings) review.findingsCount = findings.length;
  if (typeof detail.prNumber === "number") review.prNumber = detail.prNumber;
  return Object.keys(review).length > 0 ? review : undefined;
}

// Walk all history events (activity failures + workflow failure) and collect
// every human-pause failure encountered. Useful for surfacing pauses raised
// during a still-running workflow as well as terminal pauses.
export function extractHumanPauses(
  events: DecodedHistoryEvent[],
  workflowFailure?: DecodedFailure,
): HumanPause[] {
  const out: HumanPause[] = [];
  for (const ev of events) {
    if (ev.failure) {
      const pause = failureToHumanPause(ev.failure, ev.timestamp);
      if (pause) out.push(pause);
    }
  }
  if (workflowFailure) {
    const pause = failureToHumanPause(workflowFailure);
    if (pause) {
      // Replace the last duplicate match if it has the same failureType.
      const last = out[out.length - 1];
      if (!last || last.failureType !== pause.failureType) {
        out.push(pause);
      }
    }
  }
  return out;
}

export function workflowFailureToTerminal(
  failure: DecodedFailure | undefined,
  occurredAt?: string,
): TerminalFailure | undefined {
  if (!failure) return undefined;
  const pause = failureToHumanPause(failure, occurredAt);
  if (pause) return pause;
  const generic: WorkflowFailure = {
    type: "workflow-failure",
    failureType: failure.failureType,
    message: failure.message,
    occurredAt,
  };
  return generic;
}

// Group `runReviewPhase` activity attempts into review rounds. The workflow
// numbers rounds 0..N-1 in the input, but we don't decode every input here
// — instead we infer round index from the activity ordering.
export function groupReviewRounds(events: DecodedHistoryEvent[]): ReviewRoundSummary[] {
  // Map scheduledEventId -> {activityType, scheduled timestamp} for review
  // and review-post activities.
  type ReviewActivity = {
    scheduledEventId: number;
    timestamp?: string;
    completedTimestamp?: string;
    status: TimelineEventStatus;
    output?: unknown;
    failure?: DecodedFailure;
    round?: number;
  };
  const reviews: ReviewActivity[] = [];
  const reviewPosts: ReviewActivity[] = [];
  const byScheduledId = new Map<number, { kind: "review" | "post"; ref: ReviewActivity }>();

  for (const ev of events) {
    if (ev.type === "activity-task-scheduled") {
      if (ev.activityType === "runReviewPhase") {
        const round = pickRoundFromInput(ev.input) ?? reviews.length;
        const ref: ReviewActivity = {
          scheduledEventId: ev.eventId,
          timestamp: ev.timestamp,
          status: "pending",
          round,
        };
        reviews.push(ref);
        byScheduledId.set(ev.eventId, { kind: "review", ref });
      } else if (ev.activityType === "postPullRequestReviewActivity") {
        const ref: ReviewActivity = {
          scheduledEventId: ev.eventId,
          timestamp: ev.timestamp,
          status: "pending",
        };
        reviewPosts.push(ref);
        byScheduledId.set(ev.eventId, { kind: "post", ref });
      }
      continue;
    }
    if (ev.scheduledEventId === undefined) continue;
    const tracked = byScheduledId.get(ev.scheduledEventId);
    if (!tracked) continue;
    if (ev.type === "activity-task-started") {
      tracked.ref.status = "running";
    } else if (ev.type === "activity-task-completed") {
      tracked.ref.status = "completed";
      tracked.ref.completedTimestamp = ev.timestamp;
      tracked.ref.output = ev.output;
    } else if (ev.type === "activity-task-failed") {
      tracked.ref.status = "failed";
      tracked.ref.completedTimestamp = ev.timestamp;
      tracked.ref.failure = ev.failure;
    } else if (
      ev.type === "activity-task-canceled" ||
      ev.type === "activity-task-cancel-requested"
    ) {
      tracked.ref.status = "cancelled";
    } else if (ev.type === "activity-task-timed-out") {
      tracked.ref.status = "failed";
      tracked.ref.failure = ev.failure;
    }
  }

  // Pair each review-post with the most recent review whose round matches.
  // The workflow posts a review immediately after each runReviewPhase, so
  // simple by-order pairing works.
  const out: ReviewRoundSummary[] = reviews.map((r, idx) => {
    const round = r.round ?? idx;
    const post = reviewPosts[idx];
    const review = decodeReviewResult(r.output);
    return {
      round,
      attemptId: `review-${round}`,
      startedAt: r.timestamp,
      completedAt: r.completedTimestamp,
      status: r.status,
      verdict: review?.verdict,
      reasoning: review?.reasoning,
      findingsCount: review?.findingsCount,
      prNumber: review?.prNumber ?? extractPrNumberFromInput(r),
      prPostStatus: post?.status,
    };
  });
  return out;
}

function pickRoundFromInput(input: unknown): number | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.round === "number" && Number.isFinite(obj.round)) {
      return obj.round;
    }
  }
  if (Array.isArray(input)) {
    const first = input[0];
    if (first && typeof first === "object") {
      const round = (first as Record<string, unknown>).round;
      if (typeof round === "number") return round;
    }
  }
  return undefined;
}

function extractPrNumberFromInput(_review: unknown): number | undefined {
  // We do not currently decode reviewer activity input — the workflow holds
  // the PR number in workflow state and embeds it in the activity input. If
  // future decoding picks this up, this hook is the place to thread it
  // through. Returning undefined keeps the prior behavior stable.
  return undefined;
}

function decodeReviewResult(output: unknown): ReviewSummary | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const obj = output as Record<string, unknown>;
  const summary: ReviewSummary = {};
  if (typeof obj.verdict === "string") summary.verdict = obj.verdict;
  if (typeof obj.reasoning === "string") summary.reasoning = obj.reasoning;
  if (Array.isArray(obj.findings)) summary.findingsCount = obj.findings.length;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function buildTemporalWebUrl(
  base: string | undefined,
  namespace: string,
  workflowId: string,
  runId?: string,
): string | undefined {
  if (!base || base.trim().length === 0) return undefined;
  const cleanBase = base.replace(/\/+$/, "");
  const wfPath = `/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
  return runId ? `${cleanBase}${wfPath}/${encodeURIComponent(runId)}` : `${cleanBase}${wfPath}`;
}
