export type CoderAttemptStatus = "success" | "retry" | "dep-missing" | "design-question";

export interface CoderAttemptResult {
  status: CoderAttemptStatus;
  reason?: string;
}

export type CoderAgentDecision =
  | { type: "report_attempt_result"; input: CoderAttemptResult }
  | { type: "no_tool_call" }
  | { type: "malformed_tool_call"; tool: string; error: string };

export interface CoderAgentRunOptions {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}

export interface CoderAgentSession {
  next(correctiveMessage?: string): Promise<CoderAgentDecision>;
  close(): Promise<void>;
}

export interface CoderAgentClient {
  startSession(options: CoderAgentRunOptions): Promise<CoderAgentSession>;
}
