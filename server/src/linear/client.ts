import { LinearClient as LinearSdkClient } from "@linear/sdk";
import { resolveRepoSlugFromLabels } from "./resolveRepoSlug.js";
import {
  type CreatedSubTicket,
  type LinearClientApi,
  type ResolvedTicket,
  SUPPORTED_SUB_TICKET_TYPES,
  type PostedComment,
  type SupportedSubTicketType,
} from "./types.js";

export type { SupportedSubTicketType } from "./types.js";

export interface CreateLinearClientOptions {
  apiKey?: string;
  teamId?: string;
  apiUrl?: string;
  // Set of registered repo slugs (typically loaded once from build/repos.json
  // by the calling activity). Required at call time of listAgentReadyTickets;
  // pass it through here so the client doesn't re-read disk per call. When
  // omitted, listAgentReadyTickets throws — callers must provide it.
  repoSlugs?: ReadonlySet<string>;
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
        description
        priority
        labelIds
        labels {
          nodes {
            id
            name
          }
        }
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

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation UpdateIssueState($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
    }
  }
`;

interface ListAgentReadyTicketsResponse {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      description?: string | null;
      priority?: number;
      labelIds?: string[];
      labels?: {
        nodes?: Array<{ id: string; name: string }>;
      };
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

interface UpdateIssueStateResponse {
  issueUpdate: {
    success: boolean;
  };
}

export function createLinearClient(options: CreateLinearClientOptions = {}): LinearClientApi {
  const apiKey = requiredEnv("LINEAR_API_KEY", options.apiKey ?? process.env.LINEAR_API_KEY);
  const teamId = requiredEnv("LINEAR_TEAM_ID", options.teamId ?? process.env.LINEAR_TEAM_ID);
  const sdk = new LinearSdkClient({ apiKey, apiUrl: options.apiUrl });
  const repoSlugs = options.repoSlugs;

  return {
    async listAgentReadyTickets(): Promise<ResolvedTicket[]> {
      try {
        if (!repoSlugs) {
          throw new Error(
            "createLinearClient was called without repoSlugs; listAgentReadyTickets needs the registry to resolve targetRepoSlug",
          );
        }

        const tickets: ResolvedTicket[] = [];
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

          for (const node of page.nodes) {
            const labelNodes = node.labels?.nodes ?? [];
            const resolution = resolveRepoSlugFromLabels(labelNodes, repoSlugs);

            if (!resolution.ok) {
              const logEntry: {
                event: "linear.ticket_skipped";
                ticketId: string;
                identifier: string;
                reason: typeof resolution.reason;
                offendingSlug?: string;
              } = {
                event: "linear.ticket_skipped",
                ticketId: node.id,
                identifier: node.identifier,
                reason: resolution.reason,
              };
              if (resolution.reason === "unknown_repo_slug" && resolution.offending) {
                logEntry.offendingSlug = resolution.offending;
              }
              console.warn(JSON.stringify(logEntry));
              continue;
            }

            tickets.push({
              id: node.id,
              identifier: node.identifier,
              title: node.title,
              description: node.description ?? "",
              priority: node.priority ?? 0,
              labelIds: node.labelIds ?? [],
              targetRepoSlug: resolution.slug,
            });
          }

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

    async updateIssueState(ticketId: string, stateId: string): Promise<void> {
      try {
        const response = await sdk.client.rawRequest<
          UpdateIssueStateResponse,
          { id: string; input: { stateId: string } }
        >(UPDATE_ISSUE_STATE_MUTATION, {
          id: ticketId,
          input: {
            stateId,
          },
        });

        if (response.data?.issueUpdate.success !== true) {
          throw new Error("Linear issueUpdate did not report success");
        }
      } catch (error) {
        throw new Error("Linear updateIssueState failed", { cause: error });
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
