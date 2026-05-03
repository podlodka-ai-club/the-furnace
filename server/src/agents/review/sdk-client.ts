import {
  REVIEW_TOOL_NAMES,
  submitReviewArgsSchema,
  type SubmitReviewArgs,
} from "./tools.js";
import type {
  ReviewAgentClient,
  ReviewAgentDecision,
  ReviewAgentRunOptions,
  ReviewAgentSession,
} from "./agent.js";
import {
  SdkAgentSession,
  type AgentToolDefinition,
} from "../shared/sdk-session.js";

const SUBMIT_REVIEW_TOOL_DESCRIPTION =
  "Submit your review verdict for the open PR. Call this exactly once when you have finished reading the diff and the relevant repo files. The orchestrator will post your verdict and findings to the PR.";

const SUBMIT_REVIEW_TOOL_ACK =
  "Review submitted. The orchestrator will post your verdict and findings to the PR outside this conversation.";

// Reviewer is read-only by design — Edit/Write/Bash are intentionally omitted
// so an agent that "wants to fix it itself" cannot mutate the working tree.
const REVIEW_BUILT_IN_TOOLS = ["Read", "Glob", "Grep"] as const;
const REVIEW_MCP_SERVER_NAME = "the-furnace-reviewer";

const REVIEW_TOOL_DEFINITIONS: ReadonlyArray<AgentToolDefinition<ReviewAgentDecision>> = [
  {
    name: REVIEW_TOOL_NAMES.submitReview,
    description: SUBMIT_REVIEW_TOOL_DESCRIPTION,
    schema: submitReviewArgsSchema,
    ackText: SUBMIT_REVIEW_TOOL_ACK,
    toDecision: (args) => ({
      type: "submit_review",
      input: args as SubmitReviewArgs,
    }),
  },
];

class SdkReviewAgentSession implements ReviewAgentSession {
  private readonly inner: SdkAgentSession<ReviewAgentDecision>;

  constructor(options: ReviewAgentRunOptions) {
    this.inner = new SdkAgentSession<ReviewAgentDecision>({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      cwd: options.cwd,
      signal: options.signal,
      builtInTools: REVIEW_BUILT_IN_TOOLS,
      mcpServerName: REVIEW_MCP_SERVER_NAME,
      toolDefinitions: REVIEW_TOOL_DEFINITIONS,
    });
  }

  start(): void {
    this.inner.start();
  }

  async next(correctiveMessage?: string): Promise<ReviewAgentDecision> {
    return this.inner.next(correctiveMessage);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export class SdkReviewAgentClient implements ReviewAgentClient {
  async startSession(options: ReviewAgentRunOptions): Promise<ReviewAgentSession> {
    const session = new SdkReviewAgentSession(options);
    session.start();
    return session;
  }
}

export const defaultReviewAgentClient: ReviewAgentClient = new SdkReviewAgentClient();
