import { proxyActivities } from "@temporalio/workflow";
import type { ActivityOptions } from "@temporalio/common";
import type * as phaseActivities from "./activities/phases.js";
import { taskQueueForRepo } from "./repo-slug.js";

export type PhaseActivities = Pick<
  typeof phaseActivities,
  "runSpecPhase" | "runCoderPhase" | "runReviewPhase"
>;

export type CoderOnlyActivity = Pick<typeof phaseActivities, "runCoderPhase">;

export const PHASE_ACTIVITY_DEFAULTS: ActivityOptions = {
  startToCloseTimeout: "10 minutes",
  scheduleToStartTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
  },
};

export interface PhaseActivitiesForRepoOptions {
  overrides?: Partial<ActivityOptions>;
}

export function phaseActivitiesForRepo(
  slug: string,
  options: PhaseActivitiesForRepoOptions = {},
): PhaseActivities {
  return proxyActivities<PhaseActivities>({
    ...PHASE_ACTIVITY_DEFAULTS,
    ...options.overrides,
    taskQueue: taskQueueForRepo(slug),
  });
}

export function coderActivityForRepo(
  slug: string,
  options: PhaseActivitiesForRepoOptions = {},
): CoderOnlyActivity {
  return proxyActivities<CoderOnlyActivity>({
    ...PHASE_ACTIVITY_DEFAULTS,
    ...options.overrides,
    retry: {
      ...PHASE_ACTIVITY_DEFAULTS.retry,
      maximumAttempts: 1,
    },
    taskQueue: taskQueueForRepo(slug),
  });
}
