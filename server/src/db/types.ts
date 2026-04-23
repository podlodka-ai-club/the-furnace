export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AttemptPhase = "spec" | "code" | "review";

export type AttemptOutcome = "pending" | "passed" | "failed" | "stuck";

export type ReviewPersona = "security" | "performance" | "architect" | "naming";

export type ReviewVote = "approve" | "reject" | "abstain";

export type ProvenanceKind = "tool_call" | "tool_result" | "message" | "diff";

export interface TicketRow {
  external_id: string;
  title: string;
  ac_text: string;
  label: string;
  state: string;
  cached_at: Date;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  ticket_id: string;
  status: WorkflowRunStatus;
  started_at: Date;
  finished_at: Date | null;
}

export interface AttemptRow {
  id: string;
  run_id: string;
  phase: AttemptPhase;
  attempt_index: number;
  outcome: AttemptOutcome;
  started_at: Date;
  finished_at: Date | null;
}

export interface ReviewRow {
  id: string;
  attempt_id: string;
  persona: ReviewPersona;
  vote: ReviewVote;
  reasoning: string;
  created_at: Date;
}

export interface ProvenanceRow {
  hash: string;
  workflow_id: string;
  model: string;
  ticket_id: string | null;
  attempt_index: number | null;
  kind: ProvenanceKind;
  created_at: Date;
}
