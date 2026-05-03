// Domain types shared between the ticket-activity backend service and the
// React frontend. Kept dependency-free so they can be imported from both
// `server/src/**` (Node) and `server/ui/**` (browser/Vite).

export type WorkflowStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"
  | "timed_out"
  | "unknown";

export type WorkflowPhase =
  | "queued"
  | "spec"
  | "coder"
  | "review"
  | "completed"
  | "cancelled";

export type TimelineEventStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type TimelineEventCategory =
  | "workflow"
  | "spec"
  | "coder"
  | "review"
  | "github"
  | "linear"
  | "container"
  | "signal"
  | "other";

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface SubTicketRef {
  id?: string;
  identifier?: string;
  title?: string;
}

export type HumanPauseType =
  | "ac-clarification"
  | "dep-missing"
  | "design-question"
  | "review-round-cap";

export type HumanPauseFailureType =
  | "AcClarificationRequested"
  | "DepMissingRequested"
  | "DesignQuestionRequested"
  | "ReviewRoundCapExhausted";

export interface ReviewSummary {
  verdict?: string;
  reasoning?: string;
  findingsCount?: number;
  prNumber?: number;
}

export interface HumanPause {
  type: HumanPauseType;
  failureType: HumanPauseFailureType;
  message?: string;
  subTicket?: SubTicketRef;
  review?: ReviewSummary;
  occurredAt?: string;
}

export interface WorkflowFailure {
  type: "workflow-failure";
  failureType?: string;
  message?: string;
  occurredAt?: string;
}

export type TerminalFailure = HumanPause | WorkflowFailure;

export interface ReviewRoundSummary {
  round: number;
  attemptId?: string;
  startedAt?: string;
  completedAt?: string;
  status: TimelineEventStatus;
  verdict?: string;
  reasoning?: string;
  findingsCount?: number;
  prNumber?: number;
  prPostStatus?: TimelineEventStatus;
}

export interface TimelineEvent {
  id: string;
  eventId?: number;
  timestamp?: string;
  type: string;
  label: string;
  status: TimelineEventStatus;
  category: TimelineEventCategory;
  details?: Record<string, unknown>;
}

export interface TicketWorkflowSummary {
  workflowId: string;
  runId: string;
  ticketId?: string;
  ticketIdentifier?: string;
  title?: string;
  targetRepoSlug?: string;
  status: WorkflowStatus;
  phase?: WorkflowPhase;
  attemptCount?: number;
  currentRound?: number;
  startedAt?: string;
  closedAt?: string;
  pr?: PullRequestRef;
  terminalFailure?: TerminalFailure;
}

export interface TicketWorkflowDetail extends TicketWorkflowSummary {
  timeline: TimelineEvent[];
  reviewRounds: ReviewRoundSummary[];
  humanPauses: HumanPause[];
  temporalWebUrl?: string;
}

export type ListWorkflowsStatusFilter = "all" | "running" | "closed";

export interface ListWorkflowsParams {
  status?: ListWorkflowsStatusFilter;
  limit?: number;
}

export interface ApiErrorBody {
  error: { message: string; code?: string };
}
