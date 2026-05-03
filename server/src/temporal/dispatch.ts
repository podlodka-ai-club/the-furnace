import { proxyActivities } from "@temporalio/workflow";
import type { ActivityOptions } from "@temporalio/common";
import type * as phaseActivities from "./activities/phases.js";
import { taskQueueForRepo } from "./repo-slug.js";

export type PhaseActivities = Pick<
  typeof phaseActivities,
  "runSpecPhase" | "runCoderPhase" | "runReviewPhase"
>;

// Phase activities run inside ephemeral per-attempt containers whose worker
// shuts down after a single activity settles (see worker-entry.ts'
// `singleTaskActivity`). Activity-level retries would re-queue the next
// attempt onto a queue with no live worker. Retry orchestration therefore
// lives at the workflow level (`runPhase` in `workflows/per-ticket.ts`),
// which re-launches a container for each attempt — preserving the
// "fresh container per retry" guarantee from concept §3.6.
export const PHASE_ACTIVITY_DEFAULTS: ActivityOptions = {
  startToCloseTimeout: "10 minutes",
  scheduleToStartTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 1,
  },
};

// Maximum retries (including the first attempt) the workflow's `runPhase`
// will run for a phase activity that fails with a retryable failure.
// Each attempt launches a fresh container.
export const PHASE_MAX_ATTEMPTS = 3;

// Maximum coder ↔ reviewer iteration rounds the workflow will run before
// giving up with `ReviewRoundCapExhausted`. Workflow callers may override this
// per-execution via `PerTicketWorkflowInput.maxReviewRounds` (used by tests
// that need to force cap exhaustion); otherwise this default applies.
export const MAX_REVIEW_ROUNDS = 3;

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
