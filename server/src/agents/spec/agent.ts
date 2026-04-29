import type { ProposeFailingTestsArgs, RequestAcClarificationArgs } from "./tools.js";

// SpecAgentClient is the contract between the spec activity and whatever drives
// the model conversation. The default implementation wraps the Claude Agent SDK
// (`./sdk-client.ts`); unit tests inject a stub that scripts decisions.
//
// The abstraction is "next decision, optionally preceded by a corrective
// message". The activity owns the verification and commit logic; the agent
// just decides which of the two terminal tools to call.

export type SpecAgentDecision =
  | { type: "propose_failing_tests"; input: ProposeFailingTestsArgs }
  | { type: "request_ac_clarification"; input: RequestAcClarificationArgs }
  | { type: "no_tool_call" }
  | { type: "malformed_tool_call"; tool: string; error: string };

export interface SpecAgentRunOptions {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  signal: AbortSignal;
}

export interface SpecAgentSession {
  // Drive the conversation forward. On the first call, sends the initial
  // userPrompt; on subsequent calls, sends the supplied corrective message.
  // Returns the next terminal decision (or signal that the agent failed to
  // produce one this turn).
  next(correctiveMessage?: string): Promise<SpecAgentDecision>;
  close(): Promise<void>;
}

export interface SpecAgentClient {
  startSession(options: SpecAgentRunOptions): Promise<SpecAgentSession>;
}
