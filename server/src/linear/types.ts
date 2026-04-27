export const SUPPORTED_SUB_TICKET_TYPES = [
  "ac-clarification",
  "dep-missing",
  "design-question",
] as const;

export type SupportedSubTicketType = (typeof SUPPORTED_SUB_TICKET_TYPES)[number];

export interface Ticket {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  labelIds: string[];
  // The slug from build/repos.json identifying which target repo this ticket
  // operates on. Resolution from a Linear ticket field is owned by the
  // linear-integration change; container-as-worker only requires that the
  // slug is present in the ticket payload by the time the workflow starts.
  targetRepoSlug?: string;
}

export interface CreatedSubTicket {
  id: string;
  identifier: string;
  title: string;
}

export interface PostedComment {
  id: string;
}

export interface UpdateIssueStateInput {
  ticketId: string;
  stateId: string;
}

export interface LinearClientApi {
  listAgentReadyTickets(): Promise<Ticket[]>;
  createSubTicket(
    parentId: string,
    type: SupportedSubTicketType,
    body: string,
    workflowDeepLink: string,
  ): Promise<CreatedSubTicket>;
  postComment(ticketId: string, body: string): Promise<PostedComment>;
  updateIssueState(ticketId: string, stateId: string): Promise<void>;
}
