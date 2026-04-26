import { ScheduleAlreadyRunning, type ScheduleClient } from "@temporalio/client";
import { TEMPORAL_TASK_QUEUE } from "./config.js";
import { LINEAR_POLLER_WORKFLOW_NAME } from "./workflows/linear-poller.js";

export const LINEAR_POLLER_SCHEDULE_ID = "linear-poller";
export const DEFAULT_LINEAR_POLLER_INTERVAL = "1m";

export type LinearPollerScheduleOutcome = "created" | "exists";

type LinearPollerScheduleClient = Pick<ScheduleClient, "create">;

export async function ensureLinearPollerSchedule(
  scheduleClient: LinearPollerScheduleClient,
  intervalEvery: string = process.env.TEMPORAL_LINEAR_POLLER_EVERY ?? DEFAULT_LINEAR_POLLER_INTERVAL,
): Promise<LinearPollerScheduleOutcome> {
  const normalizedInterval = intervalEvery.trim();
  if (normalizedInterval.length === 0) {
    throw new Error("TEMPORAL_LINEAR_POLLER_EVERY must be a non-empty interval string");
  }

  try {
    await scheduleClient.create({
      scheduleId: LINEAR_POLLER_SCHEDULE_ID,
      spec: {
        intervals: [{ every: normalizedInterval }],
      },
      action: {
        type: "startWorkflow",
        workflowType: LINEAR_POLLER_WORKFLOW_NAME,
        taskQueue: TEMPORAL_TASK_QUEUE,
        args: [],
      },
    });
    return "created";
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      return "exists";
    }

    throw new Error(`Unable to ensure linear poller schedule '${LINEAR_POLLER_SCHEDULE_ID}'`, {
      cause: error,
    });
  }
}
