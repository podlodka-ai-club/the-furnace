import { WorkflowIdReusePolicy } from "@temporalio/common";
import { ParentClosePolicy, proxyActivities, startChild } from "@temporalio/workflow";
import type * as linearActivities from "../activities/linear.js";
import {
  buildPerTicketWorkflowId,
  PER_TICKET_WORKFLOW_NAME,
  type PerTicketWorkflowInput,
  type PerTicketWorkflowResult,
} from "./per-ticket.js";

export const LINEAR_POLLER_WORKFLOW_NAME = "linearPollerWorkflow";

export interface LinearPollerWorkflowResult {
  discovered: number;
  started: number;
  skipped: number;
}

const { listAgentReadyTicketsActivity } = proxyActivities<typeof linearActivities>({
  startToCloseTimeout: "1 minute",
});

export async function linearPollerWorkflow(): Promise<LinearPollerWorkflowResult> {
  const tickets = await listAgentReadyTicketsActivity();
  let started = 0;
  let skipped = 0;

  for (const ticket of tickets) {
    const workflowId = buildPerTicketWorkflowId(ticket.id);

    try {
      await startChild<
        (input: PerTicketWorkflowInput) => Promise<PerTicketWorkflowResult>
      >(PER_TICKET_WORKFLOW_NAME, {
        args: [
          {
            ticket: {
              id: ticket.id,
              identifier: ticket.identifier,
              title: ticket.title,
              description: ticket.description,
            },
            targetRepoSlug: ticket.targetRepoSlug,
          },
        ],
        workflowId,
        // Allow re-running a per-ticket workflow only when the previous run
        // ended in failure (e.g. acClarificationRequested). A successful run
        // is a terminal "shipped" state and must not be retriggered by the
        // poller; a failed run reflects a recoverable condition (operator
        // answered the clarification, fixed AC, etc.) so the next poll can
        // pick the ticket back up.
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      started += 1;
    } catch (error) {
      if (isAlreadyStartedError(error)) {
        skipped += 1;
        continue;
      }

      throw error;
    }
  }

  return {
    discovered: tickets.length,
    started,
    skipped,
  };
}

function isAlreadyStartedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("already started");
}
