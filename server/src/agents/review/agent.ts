import type { SubmitReviewArgs } from "./tools.js";

// ReviewAgentClient is the contract between the review activity and whatever
// drives the model conversation. The default implementation wraps the Claude
// Agent SDK (`./sdk-client.ts`); unit tests inject a stub that scripts
// decisions.

export type ReviewAgentDecision =
  | { type: "submit_review"; input: SubmitReviewArgs }
  | { type: "no_tool_call" }
  | { type: "malformed_tool_call"; tool: string; error: string };

export interface ReviewAgentRunOptions {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  signal: AbortSignal;
}

export interface ReviewAgentSession {
  next(correctiveMessage?: string): Promise<ReviewAgentDecision>;
  close(): Promise<void>;
}

export interface ReviewAgentClient {
  startSession(options: ReviewAgentRunOptions): Promise<ReviewAgentSession>;
}
