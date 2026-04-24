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
}

export interface CreatedSubTicket {
  id: string;
  identifier: string;
  title: string;
}

export interface PostedComment {
  id: string;
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
}
