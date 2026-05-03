import {
  proposeFailingTestsArgsSchema,
  requestAcClarificationArgsSchema,
  SPEC_TOOL_NAMES,
  type ProposeFailingTestsArgs,
  type RequestAcClarificationArgs,
} from "./tools.js";
import type {
  SpecAgentClient,
  SpecAgentDecision,
  SpecAgentRunOptions,
  SpecAgentSession,
} from "./agent.js";
import {
  SdkAgentSession,
  type AgentToolDefinition,
} from "../shared/sdk-session.js";

// Default `SpecAgentClient` backed by the Claude Agent SDK. The shared
// `SdkAgentSession` handles the SDK plumbing (process spawn, MCP tool
// wiring, message pump); this module just supplies the spec-specific tool
// definitions and the read-only built-in tool set.

const PROPOSE_TOOL_DESCRIPTION =
  "Submit one or more new failing test files together with a structured implementation plan. The plan has a free-form `summary` and a flat `workItems` array (each item: `area` of backend|frontend|config|migration|docs|other, `description`, and `coveredByTests` boolean). The orchestrator writes the test files, runs the suite, and commits each test as a separate commit if at least one fails; the plan rides workflow state into the coder phase and the PR body.";

const CLARIFY_TOOL_DESCRIPTION =
  "Surface that the ticket's acceptance criteria are too ambiguous to translate into tests. The orchestrator opens a Linear sub-ticket with your questions and the workflow pauses for human input.";

const PROPOSE_TOOL_ACK =
  "Submission received. The orchestrator will verify the tests outside this conversation.";

const CLARIFY_TOOL_ACK =
  "Clarification received. The orchestrator will open a sub-ticket outside this conversation.";

// Spec phase needs read-only tools — the activity writes proposed files via
// the dedicated tool, not via direct Edit/Write calls by the agent.
const SPEC_BUILT_IN_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;
const SPEC_MCP_SERVER_NAME = "the-furnace-spec";

const SPEC_TOOL_DEFINITIONS: ReadonlyArray<AgentToolDefinition<SpecAgentDecision>> = [
  {
    name: SPEC_TOOL_NAMES.proposeFailingTests,
    description: PROPOSE_TOOL_DESCRIPTION,
    schema: proposeFailingTestsArgsSchema,
    ackText: PROPOSE_TOOL_ACK,
    toDecision: (args) => ({
      type: "propose_failing_tests",
      input: args as ProposeFailingTestsArgs,
    }),
  },
  {
    name: SPEC_TOOL_NAMES.requestAcClarification,
    description: CLARIFY_TOOL_DESCRIPTION,
    schema: requestAcClarificationArgsSchema,
    ackText: CLARIFY_TOOL_ACK,
    toDecision: (args) => ({
      type: "request_ac_clarification",
      input: args as RequestAcClarificationArgs,
    }),
  },
];

class SdkSpecAgentSession implements SpecAgentSession {
  private readonly inner: SdkAgentSession<SpecAgentDecision>;

  constructor(options: SpecAgentRunOptions) {
    this.inner = new SdkAgentSession<SpecAgentDecision>({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      cwd: options.cwd,
      signal: options.signal,
      builtInTools: SPEC_BUILT_IN_TOOLS,
      mcpServerName: SPEC_MCP_SERVER_NAME,
      toolDefinitions: SPEC_TOOL_DEFINITIONS,
    });
  }

  start(): void {
    this.inner.start();
  }

  async next(correctiveMessage?: string): Promise<SpecAgentDecision> {
    return this.inner.next(correctiveMessage);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export class SdkSpecAgentClient implements SpecAgentClient {
  async startSession(options: SpecAgentRunOptions): Promise<SpecAgentSession> {
    const session = new SdkSpecAgentSession(options);
    session.start();
    return session;
  }
}

export const defaultSpecAgentClient: SpecAgentClient = new SdkSpecAgentClient();
