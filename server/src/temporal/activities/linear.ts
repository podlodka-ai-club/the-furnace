import { createLinearClient } from "../../linear/client.js";
import type { Ticket } from "../../linear/types.js";

export async function listAgentReadyTicketsActivity(): Promise<Ticket[]> {
  const client = createLinearClient();
  return client.listAgentReadyTickets();
}

export type LinearTicketStateName = "In Progress" | "Done" | "Canceled";

export interface SyncLinearTicketStateInput {
  ticketId: string;
  stateName: LinearTicketStateName;
}

export async function syncLinearTicketStateActivity(input: SyncLinearTicketStateInput): Promise<void> {
  const client = createLinearClient();
  const stateId = getStateIdForName(input.stateName);
  await client.updateIssueState(input.ticketId, stateId);
}

function getStateIdForName(stateName: LinearTicketStateName): string {
  switch (stateName) {
    case "In Progress":
      return requiredEnv("LINEAR_STATE_ID_IN_PROGRESS", process.env.LINEAR_STATE_ID_IN_PROGRESS);
    case "Done":
      return requiredEnv("LINEAR_STATE_ID_DONE", process.env.LINEAR_STATE_ID_DONE);
    case "Canceled":
      return requiredEnv("LINEAR_STATE_ID_CANCELED", process.env.LINEAR_STATE_ID_CANCELED);
  }
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for Linear ticket state synchronization`);
  }

  return value;
}
