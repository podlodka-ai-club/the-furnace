import {
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
import type * as phaseActivities from "../activities/phases.js";
import type * as linearActivities from "../activities/linear.js";
import type * as workflowRunActivities from "../activities/workflow-runs.js";

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
}

export interface PerTicketWorkflowResult {
  status: "succeeded" | "cancelled";
}

export const cancelSignal = defineSignal("cancel");
export const currentPhaseQuery = defineQuery<PerTicketWorkflowPhase>("currentPhase");
export const attemptCountQuery = defineQuery<number>("attemptCount");

const {
  runSpecPhase,
  runCoderPhase,
  runReviewPhase,
} = proxyActivities<typeof phaseActivities>({
  startToCloseTimeout: "1 minute",
});

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

  await persistWorkflowRunStart({
    workflowId: workflowInfo().workflowId,
    ticket: input.ticket,
  });
  await syncLinearTicketStateActivity({
    ticketId: input.ticket.id,
    stateName: "In Progress",
  });

  const specOutput = await runPhase("spec", () => runSpecPhase({ ticket: input.ticket }));
  if (specOutput === null) {
    return { status: "cancelled" };
  }

  const coderOutput = await runPhase("coder", () => runCoderPhase(specOutput));
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
  await persistWorkflowRunTransition({
    workflowId: workflowInfo().workflowId,
    status: "succeeded",
  });
  return { status: "succeeded" };

  async function runPhase<T>(phase: "spec" | "coder" | "review", fn: () => Promise<T>): Promise<T | null> {
    if (cancelled) {
      await transitionToCancelled();
      return null;
    }

    currentPhase = phase;
    attemptCount += 1;
    await persistWorkflowRunTransition({
      workflowId: workflowInfo().workflowId,
      status: "running",
    });
    const output = await fn();

    if (cancelled) {
      await transitionToCancelled();
      return null;
    }

    return output;
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

export function buildPerTicketWorkflowId(ticketId: string): string {
  return `ticket-${ticketId}`;
}

export type { CoderPhaseOutput, SpecPhaseOutput };
