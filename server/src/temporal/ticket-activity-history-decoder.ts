import { defaultPayloadConverter } from "@temporalio/common";
import type { temporal } from "@temporalio/proto";
import type {
  DecodedEventType,
  DecodedFailure,
  DecodedHistoryEvent,
} from "./ticket-activity-normalize.js";

type IHistory = temporal.api.history.v1.IHistory;
type IHistoryEvent = temporal.api.history.v1.IHistoryEvent;
type IPayloads = temporal.api.common.v1.IPayloads;
type IFailure = temporal.api.failure.v1.IFailure;

const EVENT_TYPE_MAP: Record<number, DecodedEventType> = {
  1: "workflow-execution-started",
  2: "workflow-execution-completed",
  3: "workflow-execution-failed",
  4: "workflow-execution-timed-out",
  9: "workflow-task-failed",
  10: "activity-task-scheduled",
  11: "activity-task-started",
  12: "activity-task-completed",
  13: "activity-task-failed",
  14: "activity-task-timed-out",
  15: "activity-task-cancel-requested",
  16: "activity-task-canceled",
  20: "workflow-execution-cancel-requested",
  21: "workflow-execution-canceled",
  25: "marker-recorded",
  26: "workflow-execution-signaled",
  27: "workflow-execution-terminated",
};

const EVENT_TYPE_NAMES: Record<number, string> = {
  0: "EVENT_TYPE_UNSPECIFIED",
  1: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
  2: "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED",
  3: "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED",
  4: "EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT",
  5: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
  6: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
  7: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
  8: "EVENT_TYPE_WORKFLOW_TASK_TIMED_OUT",
  9: "EVENT_TYPE_WORKFLOW_TASK_FAILED",
  10: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
  11: "EVENT_TYPE_ACTIVITY_TASK_STARTED",
  12: "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
  13: "EVENT_TYPE_ACTIVITY_TASK_FAILED",
  14: "EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT",
  15: "EVENT_TYPE_ACTIVITY_TASK_CANCEL_REQUESTED",
  16: "EVENT_TYPE_ACTIVITY_TASK_CANCELED",
  17: "EVENT_TYPE_TIMER_STARTED",
  18: "EVENT_TYPE_TIMER_FIRED",
  19: "EVENT_TYPE_TIMER_CANCELED",
  20: "EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED",
  21: "EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED",
  25: "EVENT_TYPE_MARKER_RECORDED",
  26: "EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED",
  27: "EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED",
};

export function decodeHistory(history: IHistory): DecodedHistoryEvent[] {
  const events = history.events ?? [];
  const out: DecodedHistoryEvent[] = [];
  for (const ev of events) {
    out.push(decodeEvent(ev));
  }
  return out;
}

export function decodeEvent(ev: IHistoryEvent): DecodedHistoryEvent {
  const eventId = longToNumber(ev.eventId) ?? 0;
  const timestamp = timestampToIso(ev.eventTime);
  const eventType = ev.eventType ?? 0;
  const decodedType: DecodedEventType =
    EVENT_TYPE_MAP[eventType as number] ?? "unknown";
  const rawType = EVENT_TYPE_NAMES[eventType as number] ?? `EVENT_TYPE_${eventType}`;

  const base: DecodedHistoryEvent = {
    eventId,
    timestamp,
    type: decodedType,
    rawType,
  };

  if (decodedType === "workflow-execution-started") {
    const attrs = ev.workflowExecutionStartedEventAttributes ?? undefined;
    base.workflowType = attrs?.workflowType?.name ?? undefined;
    base.input = decodePayloadsAt(attrs?.input, 0);
    return base;
  }
  if (decodedType === "workflow-execution-completed") {
    const attrs = ev.workflowExecutionCompletedEventAttributes ?? undefined;
    base.output = decodePayloadsAt(attrs?.result, 0);
    return base;
  }
  if (decodedType === "workflow-execution-failed") {
    const attrs = ev.workflowExecutionFailedEventAttributes ?? undefined;
    base.failure = decodeFailure(attrs?.failure ?? undefined);
    return base;
  }
  if (decodedType === "workflow-execution-timed-out") {
    return base;
  }
  if (decodedType === "workflow-task-failed") {
    const attrs = ev.workflowTaskFailedEventAttributes ?? undefined;
    base.failure = decodeFailure(attrs?.failure ?? undefined);
    return base;
  }
  if (decodedType === "activity-task-scheduled") {
    const attrs = ev.activityTaskScheduledEventAttributes ?? undefined;
    base.activityType = attrs?.activityType?.name ?? undefined;
    base.activityId = attrs?.activityId ?? undefined;
    base.input = decodePayloadsAt(attrs?.input, 0);
    return base;
  }
  if (decodedType === "activity-task-started") {
    const attrs = ev.activityTaskStartedEventAttributes ?? undefined;
    base.scheduledEventId = longToNumber(attrs?.scheduledEventId);
    return base;
  }
  if (decodedType === "activity-task-completed") {
    const attrs = ev.activityTaskCompletedEventAttributes ?? undefined;
    base.scheduledEventId = longToNumber(attrs?.scheduledEventId);
    base.output = decodePayloadsAt(attrs?.result, 0);
    return base;
  }
  if (decodedType === "activity-task-failed") {
    const attrs = ev.activityTaskFailedEventAttributes ?? undefined;
    base.scheduledEventId = longToNumber(attrs?.scheduledEventId);
    base.failure = decodeFailure(attrs?.failure ?? undefined);
    return base;
  }
  if (decodedType === "activity-task-timed-out") {
    const attrs = ev.activityTaskTimedOutEventAttributes ?? undefined;
    base.scheduledEventId = longToNumber(attrs?.scheduledEventId);
    base.failure = decodeFailure(attrs?.failure ?? undefined);
    return base;
  }
  if (
    decodedType === "activity-task-cancel-requested" ||
    decodedType === "activity-task-canceled"
  ) {
    const attrs =
      ev.activityTaskCancelRequestedEventAttributes ??
      ev.activityTaskCanceledEventAttributes ??
      undefined;
    base.scheduledEventId = longToNumber(attrs?.scheduledEventId);
    return base;
  }
  if (decodedType === "workflow-execution-signaled") {
    const attrs = ev.workflowExecutionSignaledEventAttributes ?? undefined;
    base.signalName = attrs?.signalName ?? undefined;
    base.input = decodePayloadsAt(attrs?.input, 0);
    return base;
  }
  return base;
}

function decodePayloadsAt(payloads: IPayloads | null | undefined, index: number): unknown {
  const list = payloads?.payloads;
  if (!list || list.length <= index) return undefined;
  const target = list[index];
  if (!target) return undefined;
  try {
    // The proto type for Payload is structurally compatible with the SDK
    // Payload type used by the converter (data + metadata); cast through
    // unknown to satisfy the converter's own type while staying explicit.
    return defaultPayloadConverter.fromPayload(target as never);
  } catch {
    return undefined;
  }
}

function decodeFailure(failure: IFailure | undefined): DecodedFailure | undefined {
  if (!failure) return undefined;
  const out: DecodedFailure = {};
  if (typeof failure.message === "string") out.message = failure.message;
  const appInfo = failure.applicationFailureInfo;
  if (appInfo) {
    if (typeof appInfo.type === "string") out.failureType = appInfo.type;
    if (typeof appInfo.nonRetryable === "boolean") out.nonRetryable = appInfo.nonRetryable;
    const details = appInfo.details?.payloads ?? [];
    if (details.length > 0) {
      const decoded: unknown[] = [];
      for (const p of details) {
        try {
          decoded.push(defaultPayloadConverter.fromPayload(p as never));
        } catch {
          decoded.push(undefined);
        }
      }
      out.details = decoded;
    }
  }
  if (failure.cause) {
    out.cause = decodeFailure(failure.cause);
  }
  return out;
}

function timestampToIso(ts: { seconds?: unknown; nanos?: unknown } | null | undefined): string | undefined {
  if (!ts) return undefined;
  const seconds = longToNumber(ts.seconds);
  const nanos = typeof ts.nanos === "number" ? ts.nanos : 0;
  if (seconds === undefined) return undefined;
  const ms = seconds * 1000 + Math.floor(nanos / 1_000_000);
  return new Date(ms).toISOString();
}

export function longToNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value === "object") {
    // proto Long: { low, high, unsigned }. We expect eventIds to fit safely
    // in JS number range here.
    const obj = value as { low?: unknown; high?: unknown; toNumber?: () => number };
    if (typeof obj.toNumber === "function") {
      try {
        return obj.toNumber();
      } catch {
        // fall through to manual reconstruction
      }
    }
    if (typeof obj.low === "number" && typeof obj.high === "number") {
      // Reconstruct an unsigned 64-bit value as JS number (sufficient for
      // eventId ranges in practice).
      return obj.high * 0x1_0000_0000 + (obj.low >>> 0);
    }
  }
  return undefined;
}
