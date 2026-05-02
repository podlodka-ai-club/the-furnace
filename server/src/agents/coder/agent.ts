import type {
  ReportDepMissingArgs,
  ReportDesignQuestionArgs,
  SubmitImplementationArgs,
} from "./tools.js";

// CoderAgentClient is the contract between the coder activity and whatever
// drives the model conversation. The default implementation wraps the Claude
// Agent SDK (`./sdk-client.ts`); unit tests inject a stub that scripts
// decisions.
//
// The abstraction is "next decision, optionally preceded by a corrective
// message". The activity owns the verification and commit logic; the agent
// just decides which of the three terminal tools to call.

export type CoderAgentDecision =
  | { type: "submit_implementation"; input: SubmitImplementationArgs }
  | { type: "report_dep_missing"; input: ReportDepMissingArgs }
  | { type: "report_design_question"; input: ReportDesignQuestionArgs }
  | { type: "no_tool_call" }
  | { type: "malformed_tool_call"; tool: string; error: string };

export interface CoderAgentRunOptions {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  signal: AbortSignal;
}

export interface CoderAgentSession {
  // Drive the conversation forward. On the first call, sends the initial
  // userPrompt; on subsequent calls, sends the supplied corrective message.
  // Returns the next terminal decision (or signal that the agent failed to
  // produce one this turn).
  next(correctiveMessage?: string): Promise<CoderAgentDecision>;
  close(): Promise<void>;
}

export interface CoderAgentClient {
  startSession(options: CoderAgentRunOptions): Promise<CoderAgentSession>;
}
