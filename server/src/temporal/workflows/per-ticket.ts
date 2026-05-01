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
  CoderStuckOutput,
  CoderSuccessOutput,
  ReviewerInput,
  ReviewerTicket,
  SpecPhaseOutput,
} from "../../agents/contracts/index.js";
import type * as linearActivities from "../activities/linear.js";
import type * as workflowRunActivities from "../activities/workflow-runs.js";
import type * as workerLauncherActivities from "../activities/worker-launcher.js";
import type * as attemptsActivities from "../activities/attempts.js";
import type { LaunchWorkerContainerResult } from "../activities/worker-launcher.js";
import { coderActivityForRepo, phaseActivitiesForRepo } from "../dispatch.js";
import { coderPhaseOutputSchema } from "../../agents/contracts/index.js";

const SPEC_AC_CLARIFICATION_FAILURE_TYPE = "AcClarificationRequested";
const CODER_BLOCKED_FAILURE_TYPE = "CoderPhaseBlocked";

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

const {
  persistWorkflowRunStart,
  persistWorkflowRunTransition,
} = proxyActivities<typeof workflowRunActivities>({
  startToCloseTimeout: "1 minute",
});

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

// recordAttempt is registered ONLY on the orchestrator worker (PGLite is
// in-process there). Per-repo container workers cannot reach it. See
// `openspec/changes/spec-agent/design.md` §6 for the wiring rationale.
const { recordAttempt } = proxyActivities<typeof attemptsActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "10 seconds",
    maximumAttempts: 3,
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

  const { runSpecPhase, runReviewPhase } = phaseActivitiesForRepo(
    input.targetRepoSlug,
  );
  const { runCoderPhase } = coderActivityForRepo(input.targetRepoSlug);

  await persistWorkflowRunStart({
    workflowId: workflowInfo().workflowId,
    ticket: input.ticket,
  });
  await syncLinearTicketStateActivity({
    ticketId: input.ticket.id,
    stateName: "In Progress",
  });

  const specOutput = await runSpecPhaseWithRecording();
  if (specOutput === null) {
    return { status: "cancelled" };
  }

  const coderOutput = await runCoderPhaseWithRetries(specOutput);
  if (coderOutput === null) {
    return { status: "cancelled" };
  }

  if (coderOutput.status === "stuck") {
    await persistWorkflowRunTransition({
      workflowId: workflowInfo().workflowId,
      status: "failed",
    });
    throw ApplicationFailure.nonRetryable(
      `Coder blocked with ${coderOutput.stuckType}`,
      CODER_BLOCKED_FAILURE_TYPE,
      { coderOutput },
    );
  }

  const successOutput = coderOutput as CoderSuccessOutput;
  const reviewerInput: ReviewerInput = {
    ticket: input.ticket,
    featureBranch: successOutput.featureBranch,
    finalCommitSha: successOutput.finalCommitSha,
    diffManifest: successOutput.diffManifest,
    diffStat: successOutput.diffStat,
    testRunSummary: successOutput.testRunSummary,
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
  await persistWorkflowRunTransition({
    workflowId: workflowInfo().workflowId,
    status: "succeeded",
  });
  return { status: "succeeded" };

  async function runSpecPhaseWithRecording(): Promise<SpecPhaseOutput | null> {
    if (cancelled) {
      await transitionToCancelled();
      return null;
    }

    currentPhase = "spec";
    attemptCount += 1;
    const attemptIndex = attemptCount - 1;
    await persistWorkflowRunTransition({
      workflowId: workflowInfo().workflowId,
      status: "running",
    });

    const launch: LaunchWorkerContainerResult = await launchWorkerContainer({
      ticketId: input.ticket.id,
      phase: "spec",
      attemptId: `${workflowInfo().workflowId}:spec:${attemptCount}`,
      repoSlug: input.targetRepoSlug,
    });
    void launch;

    await recordAttempt({
      workflowId: workflowInfo().workflowId,
      phase: "spec",
      attemptIndex,
      outcome: "pending",
    });

    let output: SpecPhaseOutput;
    try {
      output = await runSpecPhase({ ticket: input.ticket });
    } catch (err) {
      if (isAcClarificationFailure(err)) {
        await recordAttempt({
          workflowId: workflowInfo().workflowId,
          phase: "spec",
          attemptIndex,
          outcome: "stuck",
        });
        // Persist run as failed; the structured failure detail (subTicketRef)
        // is preserved in Temporal's workflow event history via the rethrown
        // ApplicationFailure. We deliberately do NOT sync the Linear ticket
        // to "Canceled" — it must remain "In Progress" so a human can
        // resolve the clarification.
        await persistWorkflowRunTransition({
          workflowId: workflowInfo().workflowId,
          status: "failed",
        });
        throw err;
      }
      await recordAttempt({
        workflowId: workflowInfo().workflowId,
        phase: "spec",
        attemptIndex,
        outcome: "failed",
      });
      throw err;
    }

    // Match the original phase-cancel timing: check cancel immediately after
    // the gated activity returns and before any further activity dispatches.
    // If we're cancelled, leave the attempts row at `pending` and tear down.
    if (cancelled) {
      await transitionToCancelled();
      return null;
    }

    await recordAttempt({
      workflowId: workflowInfo().workflowId,
      phase: "spec",
      attemptIndex,
      outcome: "passed",
    });

    return output;
  }

  async function runPhase<T>(phase: "spec" | "coder" | "review", fn: () => Promise<T>): Promise<T | null> {
    if (cancelled) {
      await transitionToCancelled();
      return null;
    }

    currentPhase = phase;
    attemptCount += 1;
    const attemptIndex = attemptCount - 1;
    await persistWorkflowRunTransition({
      workflowId: workflowInfo().workflowId,
      status: "running",
    });

    // Each phase invocation (including Temporal-driven retries of this code path)
    // launches a fresh container per the single-task lifetime contract.
    const launch: LaunchWorkerContainerResult = await launchWorkerContainer({
      ticketId: input.ticket.id,
      phase,
      attemptId: `${workflowInfo().workflowId}:${phase}:${attemptCount}`,
      repoSlug: input.targetRepoSlug,
    });
    void launch;

    if (phase === "coder") {
      await recordAttempt({
        workflowId: workflowInfo().workflowId,
        phase: "coder",
        attemptIndex,
        outcome: "pending",
      });
    }

    let output: T;
    try {
      output = await fn();
    } catch (err) {
      if (phase === "coder") {
        const stuck = extractCoderStuckOutput(err);
        if (stuck) {
          await recordAttempt({
            workflowId: workflowInfo().workflowId,
            phase: "coder",
            attemptIndex,
            outcome: stuck.stuckType,
          });
        } else {
          await recordAttempt({
            workflowId: workflowInfo().workflowId,
            phase: "coder",
            attemptIndex,
            outcome: "retry",
          });
        }
      }
      throw err;
    }

    if (cancelled) {
      await transitionToCancelled();
      return null;
    }

    if (phase === "coder") {
      await recordAttempt({
        workflowId: workflowInfo().workflowId,
        phase: "coder",
        attemptIndex,
        outcome: "tests-green",
      });
    }

    return output;
  }

  async function runCoderPhaseWithRetries(specOutput: SpecPhaseOutput): Promise<CoderPhaseOutput | null> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const output = await runPhase("coder", () => runCoderPhase(specOutput));
        return output;
      } catch (err) {
        lastErr = err;
        if (extractCoderStuckOutput(err)) {
          throw err;
        }
      }
    }
    throw lastErr;
  }

  async function transitionToCancelled(): Promise<void> {
    currentPhase = "cancelled";
    await syncLinearTicketStateActivity({
      ticketId: input.ticket.id,
      stateName: "Canceled",
    });
    await persistWorkflowRunTransition({
      workflowId: workflowInfo().workflowId,
      status: "cancelled",
    });
  }
}

function extractCoderStuckOutput(err: unknown): CoderStuckOutput | null {
  const application = err instanceof ActivityFailure
    ? (err.cause instanceof ApplicationFailure ? err.cause : null)
    : (err instanceof ApplicationFailure ? err : null);
  if (!application) return null;
  const details = application.details as unknown;
  if (!Array.isArray(details) || details.length === 0) return null;
  const maybe = (details[0] as { coderOutput?: unknown }).coderOutput;
  const parsed = coderPhaseOutputSchema.safeParse(maybe);
  if (!parsed.success || parsed.data.status !== "stuck") return null;
  return parsed.data;
}

export function buildPerTicketWorkflowId(ticketId: string): string {
  return `ticket-${ticketId}`;
}

// Activities that throw `ApplicationFailure.nonRetryable(..., type, details)`
// surface in workflows as `ActivityFailure` with `cause` set to the
// `ApplicationFailure`. We also accept a bare `ApplicationFailure` for
// completeness (e.g. when the failure originates from inside a child workflow
// or is rethrown manually).
function isAcClarificationFailure(err: unknown): boolean {
  if (err instanceof ApplicationFailure && err.type === SPEC_AC_CLARIFICATION_FAILURE_TYPE) {
    return true;
  }
  if (err instanceof ActivityFailure) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure && cause.type === SPEC_AC_CLARIFICATION_FAILURE_TYPE) {
      return true;
    }
  }
  return false;
}

export type { CoderPhaseOutput, SpecPhaseOutput };
export type { CoderStuckOutput, CoderSuccessOutput };
