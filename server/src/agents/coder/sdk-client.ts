import {
  CODER_TOOL_NAMES,
  reportDepMissingArgsSchema,
  reportDesignQuestionArgsSchema,
  submitImplementationArgsSchema,
  type ReportDepMissingArgs,
  type ReportDesignQuestionArgs,
  type SubmitImplementationArgs,
} from "./tools.js";
import type {
  CoderAgentClient,
  CoderAgentDecision,
  CoderAgentRunOptions,
  CoderAgentSession,
} from "./agent.js";
import {
  SdkAgentSession,
  type AgentToolDefinition,
} from "../shared/sdk-session.js";

// Default `CoderAgentClient` backed by the Claude Agent SDK. Composes the
// shared `SdkAgentSession` with the coder's three terminal tools and the
// extended built-in tool set (Edit/Write are needed in addition to read-only
// tools so the agent can iterate production code).

const SUBMIT_TOOL_DESCRIPTION =
  "Submit your implementation. Call this when you believe the spec phase's failing tests now pass on the current branch. The orchestrator will run the test suite, verify you did not modify test files, commit your changes, and push.";

const DEP_MISSING_TOOL_DESCRIPTION =
  "Report that finishing the implementation requires a dependency that is not currently available in the repo (a library not in package.json, an unreachable service, a missing API key, etc.). The orchestrator opens a dep-missing Linear sub-ticket and the workflow pauses.";

const DESIGN_QUESTION_TOOL_DESCRIPTION =
  "Report that finishing the implementation requires a design-level decision a human should make (architectural trade-off, naming, module boundary, etc.). The orchestrator opens a design-question Linear sub-ticket and the workflow pauses.";

const SUBMIT_TOOL_ACK =
  "Submission received. The orchestrator will verify tests and commit outside this conversation.";

const DEP_MISSING_TOOL_ACK =
  "Dep-missing report received. The orchestrator will open a sub-ticket outside this conversation.";

const DESIGN_QUESTION_TOOL_ACK =
  "Design-question report received. The orchestrator will open a sub-ticket outside this conversation.";

const CODER_BUILT_IN_TOOLS = ["Read", "Glob", "Grep", "Bash", "Edit", "Write"] as const;
const CODER_MCP_SERVER_NAME = "the-furnace-coder";

const CODER_TOOL_DEFINITIONS: ReadonlyArray<AgentToolDefinition<CoderAgentDecision>> = [
  {
    name: CODER_TOOL_NAMES.submitImplementation,
    description: SUBMIT_TOOL_DESCRIPTION,
    schema: submitImplementationArgsSchema,
    ackText: SUBMIT_TOOL_ACK,
    toDecision: (args) => ({
      type: "submit_implementation",
      input: args as SubmitImplementationArgs,
    }),
  },
  {
    name: CODER_TOOL_NAMES.reportDepMissing,
    description: DEP_MISSING_TOOL_DESCRIPTION,
    schema: reportDepMissingArgsSchema,
    ackText: DEP_MISSING_TOOL_ACK,
    toDecision: (args) => ({
      type: "report_dep_missing",
      input: args as ReportDepMissingArgs,
    }),
  },
  {
    name: CODER_TOOL_NAMES.reportDesignQuestion,
    description: DESIGN_QUESTION_TOOL_DESCRIPTION,
    schema: reportDesignQuestionArgsSchema,
    ackText: DESIGN_QUESTION_TOOL_ACK,
    toDecision: (args) => ({
      type: "report_design_question",
      input: args as ReportDesignQuestionArgs,
    }),
  },
];

class SdkCoderAgentSession implements CoderAgentSession {
  private readonly inner: SdkAgentSession<CoderAgentDecision>;

  constructor(options: CoderAgentRunOptions) {
    this.inner = new SdkAgentSession<CoderAgentDecision>({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      cwd: options.cwd,
      signal: options.signal,
      builtInTools: CODER_BUILT_IN_TOOLS,
      mcpServerName: CODER_MCP_SERVER_NAME,
      toolDefinitions: CODER_TOOL_DEFINITIONS,
    });
  }

  start(): void {
    this.inner.start();
  }

  async next(correctiveMessage?: string): Promise<CoderAgentDecision> {
    return this.inner.next(correctiveMessage);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export class SdkCoderAgentClient implements CoderAgentClient {
  async startSession(options: CoderAgentRunOptions): Promise<CoderAgentSession> {
    const session = new SdkCoderAgentSession(options);
    session.start();
    return session;
  }
}

export const defaultCoderAgentClient: CoderAgentClient = new SdkCoderAgentClient();
