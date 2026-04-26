import { ScheduleAlreadyRunning } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LINEAR_POLLER_INTERVAL,
  LINEAR_POLLER_SCHEDULE_ID,
  ensureLinearPollerSchedule,
} from "../src/temporal/schedule.js";
import { LINEAR_POLLER_WORKFLOW_NAME } from "../src/temporal/workflows/linear-poller.js";
import { TEMPORAL_TASK_QUEUE } from "../src/temporal/config.js";

describe("ensureLinearPollerSchedule", () => {
  it("creates schedule with one-minute default interval", async () => {
    const create = vi.fn(async () => ({}));

    const outcome = await ensureLinearPollerSchedule({ create });

    expect(outcome).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      scheduleId: LINEAR_POLLER_SCHEDULE_ID,
      spec: {
        intervals: [{ every: DEFAULT_LINEAR_POLLER_INTERVAL }],
      },
      action: {
        type: "startWorkflow",
        workflowType: LINEAR_POLLER_WORKFLOW_NAME,
        taskQueue: TEMPORAL_TASK_QUEUE,
        args: [],
      },
    });
  });

  it("returns exists when schedule is already present", async () => {
    const create = vi.fn(async () => {
      throw new ScheduleAlreadyRunning("already exists", LINEAR_POLLER_SCHEDULE_ID);
    });

    const outcome = await ensureLinearPollerSchedule({ create });

    expect(outcome).toBe("exists");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
