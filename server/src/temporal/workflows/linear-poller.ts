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
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
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
