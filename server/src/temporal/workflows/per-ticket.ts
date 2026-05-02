import {
  ActivityFailure,
  ApplicationFailure,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  CoderPhaseOutput,
  ReviewerInput,
  ReviewerTicket,
  SpecPhaseOutput,
} from "../../agents/contracts/index.js";
import type * as linearActivities from "../activities/linear.js";
import type * as workerLauncherActivities from "../activities/worker-launcher.js";
import type { LaunchWorkerContainerResult } from "../activities/worker-launcher.js";
import { PHASE_MAX_ATTEMPTS, phaseActivitiesForRepo } from "../dispatch.js";

const SPEC_AC_CLARIFICATION_FAILURE_TYPE = "AcClarificationRequested";
const CODER_DEP_MISSING_FAILURE_TYPE = "DepMissingRequested";
const CODER_DESIGN_QUESTION_FAILURE_TYPE = "DesignQuestionRequested";

export const PER_TICKET_WORKFLOW_NAME = "perTicketWorkflow";

export type PerTicketWorkflowPhase =
  | "queued"
  | "spec"
  | "coder"
  | "review"
  | "completed"
  | "cancelled";

export interface PerTicketWorkflowInput {
  ticket: ReviewerTicket;
  // Required: identifies which per-repo task queue to dispatch phase activities
  // to and which container image to launch. See container-worker-lifecycle spec.
  targetRepoSlug: string;
}

export interface PerTicketWorkflowResult {
  status: "succeeded" | "cancelled";
}

export const cancelSignal = defineSignal("cancel");
export const currentPhaseQuery = defineQuery<PerTicketWorkflowPhase>("currentPhase");
export const attemptCountQuery = defineQuery<number>("attemptCount");

const { syncLinearTicketStateActivity } = proxyActivities<typeof linearActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

const { launchWorkerContainer } = proxyActivities<typeof workerLauncherActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

const { validateRepoSlug } = proxyActivities<typeof workerLauncherActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumAttempts: 1,
  },
});

export async function perTicketWorkflow(
  input: PerTicketWorkflowInput,
): Promise<PerTicketWorkflowResult> {
  let currentPhase: PerTicketWorkflowPhase = "queued";
  let attemptCount = 0;
  let cancelled = false;

  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(currentPhaseQuery, () => currentPhase);
  setHandler(attemptCountQuery, () => attemptCount);

  // Defense-in-depth: the Linear client now guarantees a non-empty slug at the
  // producer boundary (see linear-target-repo-resolution change), so this check
  // is dead code on the linear-poller path. It still guards manual workflow
  // starts that bypass the Linear client.
  if (!input.targetRepoSlug || input.targetRepoSlug.trim().length === 0) {
    throw ApplicationFailure.nonRetryable(
      "perTicketWorkflow requires targetRepoSlug; got empty value",
      "InvalidWorkflowInput",
    );
  }

  // Fail fast if the slug is unknown — surfaces UnknownRepoSlugError before
  // any container launch.
  await validateRepoSlug({ slug: input.targetRepoSlug });

  const { runSpecPhase, runCoderPhase, runReviewPhase } = phaseActivitiesForRepo(
    input.targetRepoSlug,
  );

  await syncLinearTicketStateActivity({
    ticketId: input.ticket.id,
    stateName: "In Progress",
  });

  const specOutput = await runSpecPhaseWithRecording();
  if (specOutput === null) {
    return { status: "cancelled" };
  }

  // Stuck-failures (DepMissingRequested, DesignQuestionRequested) propagate
  // out of runPhase without retrying. The workflow does NOT sync the Linear
  // ticket to "Canceled" — it stays "In Progress" so a human can resolve the
  // sub-ticket and the orchestrator re-enqueues from `agent-ready`. The
  // structured failure detail (`subTicketRef`) is preserved in Temporal's
  // workflow event history via the rethrown ApplicationFailure.
  const coderOutput: CoderPhaseOutput | null = await runPhase(
    "coder",
    () => runCoderPhase({ ticket: input.ticket, specOutput }),
    {
      stuckFailureTypes: [
        CODER_DEP_MISSING_FAILURE_TYPE,
        CODER_DESIGN_QUESTION_FAILURE_TYPE,
      ],
    },
  );
  if (coderOutput === null) {
    return { status: "cancelled" };
  }

  const reviewerInput: ReviewerInput = {
    ...coderOutput,
    ticket: input.ticket,
  };
  const reviewOutput = await runPhase("review", () => runReviewPhase(reviewerInput));
  if (reviewOutput === null) {
    return { status: "cancelled" };
  }

  currentPhase = "completed";
  await syncLinearTicketStateActivity({
    ticketId: input.ticket.id,
    stateName: "Done",
  });
  return { status: "succeeded" };

  async function runSpecPhaseWithRecording(): Promise<SpecPhaseOutput | null> {
    return await runPhase("spec", () => runSpecPhase({ ticket: input.ticket }), {
      stuckFailureTypes: [SPEC_AC_CLARIFICATION_FAILURE_TYPE],
    });
  }

  // Per concept §3.6, every retry of a phase activity must run in a fresh
  // container. The per-attempt container worker shuts down after a single
  // activity settles (see worker-entry.ts > singleTaskActivity), so
  // activity-level retries would re-queue onto a dead worker. Retry
  // orchestration therefore lives here: each loop iteration launches a fresh
  // container and dispatches the phase activity once.
  //
  // Failures whose `ApplicationFailure.type` is in `stuckFailureTypes` skip
  // the retry loop and propagate up so the workflow can convert them into
  // Linear sub-tickets without spending retry budget.
  async function runPhase<T>(
    phase: "spec" | "coder" | "review",
    fn: () => Promise<T>,
    options: { stuckFailureTypes?: readonly string[] } = {},
  ): Promise<T | null> {
    const stuckTypes = options.stuckFailureTypes ?? [];
    let lastError: unknown;
    for (let attempt = 1; attempt <= PHASE_MAX_ATTEMPTS; attempt += 1) {
      if (cancelled) {
        await transitionToCancelled();
        return null;
      }

      currentPhase = phase;
      attemptCount += 1;

      const launch: LaunchWorkerContainerResult = await launchWorkerContainer({
        ticketId: input.ticket.id,
        phase,
        attemptId: `${workflowInfo().workflowId}:${phase}:${attemptCount}`,
        repoSlug: input.targetRepoSlug,
      });
      void launch;

      try {
        const output = await fn();

        if (cancelled) {
          await transitionToCancelled();
          return null;
        }

        return output;
      } catch (err) {
        if (stuckTypes.some((t) => matchFailureType(err, t))) {
          throw err;
        }
        if (isNonRetryableFailure(err)) {
          throw err;
        }
        lastError = err;
        // Loop body re-launches a fresh container on the next iteration.
      }
    }
    throw lastError;
  }

  async function transitionToCancelled(): Promise<void> {
    currentPhase = "cancelled";
    await syncLinearTicketStateActivity({
      ticketId: input.ticket.id,
      stateName: "Canceled",
    });
  }
}

export function buildPerTicketWorkflowId(ticketId: string): string {
  return `ticket-${ticketId}`;
}

// Activities that throw `ApplicationFailure.nonRetryable(..., type, details)`
// surface in workflows as `ActivityFailure` with `cause` set to the
// `ApplicationFailure`. We also accept a bare `ApplicationFailure` for
// completeness (e.g. when the failure originates from inside a child workflow
// or is rethrown manually).
// An activity that throws `ApplicationFailure.nonRetryable(...)` surfaces in
// the workflow as `ActivityFailure` with `cause` set to the non-retryable
// `ApplicationFailure`. The workflow-level retry loop must honor that flag —
// otherwise we'd re-launch a container only to repeat a failure the activity
// has already declared terminal.
function isNonRetryableFailure(err: unknown): boolean {
  if (err instanceof ApplicationFailure) {
    return err.nonRetryable === true;
  }
  if (err instanceof ActivityFailure) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure) {
      return cause.nonRetryable === true;
    }
  }
  return false;
}

function matchFailureType(err: unknown, type: string): boolean {
  if (err instanceof ApplicationFailure && err.type === type) {
    return true;
  }
  if (err instanceof ActivityFailure) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure && cause.type === type) {
      return true;
    }
  }
  return false;
}

export type { CoderPhaseOutput, SpecPhaseOutput };
