import { createLinearClient } from "../../linear/client.js";
import type { ResolvedTicket } from "../../linear/types.js";
import { loadRepoSlugRegistry } from "../repo-registry.js";

let cachedRepoSlugs: ReadonlySet<string> | undefined;

async function getRepoSlugs(): Promise<ReadonlySet<string>> {
  if (cachedRepoSlugs) {
    return cachedRepoSlugs;
  }
  const registry = await loadRepoSlugRegistry();
  cachedRepoSlugs = new Set(registry.map((entry) => entry.slug));
  return cachedRepoSlugs;
}

export async function listAgentReadyTicketsActivity(): Promise<ResolvedTicket[]> {
  const repoSlugs = await getRepoSlugs();
  const client = createLinearClient({ repoSlugs });
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
