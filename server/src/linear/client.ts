import { LinearClient as LinearSdkClient } from "@linear/sdk";
import {
  type CreatedSubTicket,
  type LinearClientApi,
  SUPPORTED_SUB_TICKET_TYPES,
  type PostedComment,
  type SupportedSubTicketType,
  type Ticket,
} from "./types.js";

export type { SupportedSubTicketType } from "./types.js";

export interface CreateLinearClientOptions {
  apiKey?: string;
  teamId?: string;
  apiUrl?: string;
}

const SUB_TICKET_TITLES: Record<SupportedSubTicketType, string> = {
  "ac-clarification": "Needs product clarification",
  "dep-missing": "Blocked by missing dependency",
  "design-question": "Needs design decision",
};

const LIST_AGENT_READY_TICKETS_QUERY = `
  query ListAgentReadyTickets($teamId: ID!, $after: String) {
    issues(
      filter: {
        team: { id: { eq: $teamId } }
        labels: { name: { eq: "agent-ready" } }
        state: { name: { eq: "Todo" } }
      }
      first: 50
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        priority
        labelIds
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CREATE_SUB_TICKET_MUTATION = `
  mutation CreateSubTicket($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
      }
    }
  }
`;

const POST_COMMENT_MUTATION = `
  mutation PostComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
      }
    }
  }
`;

interface ListAgentReadyTicketsResponse {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      priority?: number;
      labelIds?: string[];
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface CreateSubTicketResponse {
  issueCreate: {
    success: boolean;
    issue: {
      id: string;
      identifier: string;
      title: string;
    } | null;
  };
}

interface PostCommentResponse {
  commentCreate: {
    success: boolean;
    comment: {
      id: string;
    } | null;
  };
}

export function createLinearClient(options: CreateLinearClientOptions = {}): LinearClientApi {
  const apiKey = requiredEnv("LINEAR_API_KEY", options.apiKey ?? process.env.LINEAR_API_KEY);
  const teamId = requiredEnv("LINEAR_TEAM_ID", options.teamId ?? process.env.LINEAR_TEAM_ID);
  const sdk = new LinearSdkClient({ apiKey, apiUrl: options.apiUrl });

  return {
    async listAgentReadyTickets(): Promise<Ticket[]> {
      try {
        const tickets: Ticket[] = [];
        let after: string | null = null;

        while (true) {
          const response: { data?: ListAgentReadyTicketsResponse } = await sdk.client.rawRequest<
            ListAgentReadyTicketsResponse,
            { teamId: string; after: string | null }
          >(LIST_AGENT_READY_TICKETS_QUERY, { teamId, after });

          const page: ListAgentReadyTicketsResponse["issues"] | undefined = response.data?.issues;
          if (!page) {
            throw new Error("Linear issues query returned no data");
          }

          tickets.push(
            ...page.nodes.map((node: ListAgentReadyTicketsResponse["issues"]["nodes"][number]) => ({
              id: node.id,
              identifier: node.identifier,
              title: node.title,
              priority: node.priority ?? 0,
              labelIds: node.labelIds ?? [],
            })),
          );

          if (!page.pageInfo.hasNextPage) {
            break;
          }

          after = page.pageInfo.endCursor;
        }

        return tickets;
      } catch (error) {
        throw new Error("Linear listAgentReadyTickets failed", { cause: error });
      }
    },

    async createSubTicket(
      parentId: string,
      type: SupportedSubTicketType,
      body: string,
      workflowDeepLink: string,
    ): Promise<CreatedSubTicket> {
      try {
        assertSupportedSubTicketType(type);

        const title = `${type}: ${SUB_TICKET_TITLES[type]}`;
        const description = `${body.trim()}\n\n${formatWorkflowDeepLinkSection(workflowDeepLink)}`;

        const response = await sdk.client.rawRequest<
          CreateSubTicketResponse,
          {
            input: {
              teamId: string;
              parentId: string;
              title: string;
              description: string;
              labelIds: string[];
            };
          }
        >(CREATE_SUB_TICKET_MUTATION, {
          input: {
            teamId,
            parentId,
            title,
            description,
            labelIds: [type],
          },
        });

        const created = response.data?.issueCreate.issue;
        if (!created) {
          throw new Error("Linear issueCreate returned no issue");
        }

        return {
          id: created.id,
          identifier: created.identifier,
          title: created.title,
        };
      } catch (error) {
        throw new Error("Linear createSubTicket failed", { cause: error });
      }
    },

    async postComment(ticketId: string, body: string): Promise<PostedComment> {
      try {
        const response = await sdk.client.rawRequest<
          PostCommentResponse,
          { input: { issueId: string; body: string } }
        >(POST_COMMENT_MUTATION, {
          input: {
            issueId: ticketId,
            body,
          },
        });

        const comment = response.data?.commentCreate.comment;
        if (!comment) {
          throw new Error("Linear commentCreate returned no comment");
        }

        return { id: comment.id };
      } catch (error) {
        throw new Error("Linear postComment failed", { cause: error });
      }
    },
  };
}

export function formatWorkflowDeepLinkSection(workflowDeepLink: string): string {
  return `## Workflow context\nReview the execution details: ${workflowDeepLink}`;
}

function requiredEnv(name: "LINEAR_API_KEY" | "LINEAR_TEAM_ID", value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for Linear client initialization`);
  }

  return value;
}

function assertSupportedSubTicketType(type: string): asserts type is SupportedSubTicketType {
  if (!(SUPPORTED_SUB_TICKET_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unsupported sub-ticket type: ${type}`);
  }
}
