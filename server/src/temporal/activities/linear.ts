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

export interface ResolveClarificationSubTicketInput {
  subTicketId: string;
  answer: string;
  resolvedBy?: string;
}

// Post the operator's clarification answer onto the Linear sub-ticket and
// transition the sub-ticket to Done so Linear stays consistent with the
// workflow state. Failures bubble up so Temporal can retry; the caller
// (per-ticket workflow) treats this as best-effort and re-dispatches the
// spec phase regardless.
export async function resolveClarificationSubTicketActivity(
  input: ResolveClarificationSubTicketInput,
): Promise<void> {
  const client = createLinearClient();
  const body = formatClarificationAnswerComment(input.answer, input.resolvedBy);
  await client.postComment(input.subTicketId, body);
  const doneStateId = getStateIdForName("Done");
  await client.updateIssueState(input.subTicketId, doneStateId);
}

export function formatClarificationAnswerComment(answer: string, resolvedBy?: string): string {
  const trimmed = answer.trim();
  const author = resolvedBy && resolvedBy.trim().length > 0 ? resolvedBy.trim() : "operator";
  return `## Clarification answered by ${author}\n\n${trimmed}\n`;
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
