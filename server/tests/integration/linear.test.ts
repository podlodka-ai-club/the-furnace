import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLinearClient,
  type SupportedSubTicketType,
} from "../../src/linear/client.js";

describe("Linear client integration", () => {
  const originalLinearApiKey = process.env.LINEAR_API_KEY;
  const originalLinearTeamId = process.env.LINEAR_TEAM_ID;

  afterEach(() => {
    if (originalLinearApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = originalLinearApiKey;
    }

    if (originalLinearTeamId === undefined) {
      delete process.env.LINEAR_TEAM_ID;
    } else {
      process.env.LINEAR_TEAM_ID = originalLinearTeamId;
    }

    vi.restoreAllMocks();
  });

  it("fails fast when LINEAR_API_KEY is missing", () => {
    delete process.env.LINEAR_API_KEY;
    process.env.LINEAR_TEAM_ID = "team_123";

    expect(() => createLinearClient()).toThrowError(/LINEAR_API_KEY/);
  });

  it("fails fast when LINEAR_TEAM_ID is missing", () => {
    process.env.LINEAR_API_KEY = "lin_api_key";
    delete process.env.LINEAR_TEAM_ID;

    expect(() => createLinearClient()).toThrowError(/LINEAR_TEAM_ID/);
  });

  it("lists all agent-ready tickets across pages, requests label name, and resolves slug", async () => {
    const capturedBodies: unknown[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        capturedBodies.push(parseBody(init));
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue_1",
                  identifier: "ENG-1",
                  title: "Parent ticket",
                  description: "## Acceptance Criteria\n- thing one\n- thing two",
                  priority: 2,
                  labelIds: ["lid_agent_ready", "lid_repo_demo"],
                  labels: {
                    nodes: [
                      { id: "lid_agent_ready", name: "agent-ready" },
                      { id: "lid_repo_demo", name: "repo:demo" },
                    ],
                  },
                },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor_1",
              },
            },
          },
        });
      })
      .mockImplementationOnce(async (_input, init) => {
        capturedBodies.push(parseBody(init));
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue_2",
                  identifier: "ENG-2",
                  title: "Second ticket",
                  description: null,
                  priority: 4,
                  labelIds: ["lid_agent_ready", "lid_repo_demo"],
                  labels: {
                    nodes: [
                      { id: "lid_agent_ready", name: "agent-ready" },
                      { id: "lid_repo_demo", name: "repo:demo" },
                    ],
                  },
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        });
      });

    vi.stubGlobal("fetch", fetchMock);

    const client = createLinearClient({
      apiKey: "lin_api_key",
      teamId: "team_123",
      apiUrl: "https://linear.example/graphql",
      repoSlugs: new Set(["demo"]),
    });

    const tickets = await client.listAgentReadyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tickets).toEqual([
      {
        id: "issue_1",
        identifier: "ENG-1",
        title: "Parent ticket",
        description: "## Acceptance Criteria\n- thing one\n- thing two",
        priority: 2,
        labelIds: ["lid_agent_ready", "lid_repo_demo"],
        targetRepoSlug: "demo",
      },
      {
        id: "issue_2",
        identifier: "ENG-2",
        title: "Second ticket",
        description: "",
        priority: 4,
        labelIds: ["lid_agent_ready", "lid_repo_demo"],
        targetRepoSlug: "demo",
      },
    ]);

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0]).toMatchObject({
      variables: { after: null, teamId: "team_123" },
    });
    expect(capturedBodies[0]).toMatchObject({
      query: expect.stringContaining("agent-ready"),
    });
    expect(capturedBodies[0]).toMatchObject({
      query: expect.stringContaining('state: { name: { eq: "Todo" } }'),
    });
    expect(capturedBodies[0]).toMatchObject({
      query: expect.stringContaining("($teamId: ID!, $after: String)"),
    });
    // The resolver depends on label `name`, so the GraphQL selection must request it.
    expect(capturedBodies[0]).toMatchObject({
      query: expect.stringMatching(/labels\s*\{\s*nodes\s*\{[\s\S]*\bname\b/),
    });
    // The description field must be selected so downstream code can route the
    // human-authored ticket body through the workflow.
    expect(capturedBodies[0]).toMatchObject({
      query: expect.stringMatching(/nodes\s*\{[\s\S]*\bdescription\b[\s\S]*\bpriority\b/),
    });
    expect(capturedBodies[1]).toMatchObject({
      variables: { after: "cursor_1", teamId: "team_123" },
    });
  });

  it("creates a typed sub-ticket with parent and workflow link", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = parseBody(init);
      expect(body).toMatchObject({
        query: expect.stringContaining("issueCreate"),
        variables: {
          input: {
            teamId: "team_123",
            parentId: "parent_issue_id",
            title: "ac-clarification: Needs product clarification",
          },
        },
      });
      const variables = (body as { variables: { input: Record<string, unknown> } }).variables.input;
      expect(variables).not.toHaveProperty("labelIds");

      const description = (body as { variables: { input: { description: string } } }).variables.input
        .description;
      expect(description).toContain("What should we do about edge case?");
      expect(description).toContain("## Workflow context");
      expect(description).toContain("https://furnace.local/workflows/run-123");

      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "subticket_1",
              identifier: "ENG-33",
              title: "ac-clarification: Needs product clarification",
            },
          },
        },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createLinearClient({
      apiKey: "lin_api_key",
      teamId: "team_123",
      apiUrl: "https://linear.example/graphql",
    });

    const type: SupportedSubTicketType = "ac-clarification";
    const created = await client.createSubTicket(
      "parent_issue_id",
      type,
      "What should we do about edge case?",
      "https://furnace.local/workflows/run-123",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created).toEqual({
      id: "subticket_1",
      identifier: "ENG-33",
      title: "ac-clarification: Needs product clarification",
    });
  });

  it("posts comment mutation to requested ticket", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = parseBody(init);
      expect(body).toMatchObject({
        query: expect.stringContaining("commentCreate"),
        variables: {
          input: {
            issueId: "issue_abc",
            body: "Human tiebreaker requested",
          },
        },
      });

      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment_1",
            },
          },
        },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createLinearClient({
      apiKey: "lin_api_key",
      teamId: "team_123",
      apiUrl: "https://linear.example/graphql",
    });

    const comment = await client.postComment("issue_abc", "Human tiebreaker requested");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(comment).toEqual({ id: "comment_1" });
  });

  it("updates issue state mutation with provided issue and state ids", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = parseBody(init);
      expect(body).toMatchObject({
        query: expect.stringContaining("issueUpdate"),
        variables: {
          id: "issue_abc",
          input: {
            stateId: "state_in_progress",
          },
        },
      });

      return jsonResponse({
        data: {
          issueUpdate: {
            success: true,
          },
        },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createLinearClient({
      apiKey: "lin_api_key",
      teamId: "team_123",
      apiUrl: "https://linear.example/graphql",
    });

    await expect(client.updateIssueState("issue_abc", "state_in_progress")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exports a client API that is importable by activities", async () => {
    const api = await import("../../src/linear/client.js");

    expect(typeof api.createLinearClient).toBe("function");
    expect(typeof api.formatWorkflowDeepLinkSection).toBe("function");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected request body to be a JSON string");
  }

  return JSON.parse(init.body);
}
