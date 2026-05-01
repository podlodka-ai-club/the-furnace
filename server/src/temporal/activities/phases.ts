import { Context } from "@temporalio/activity";
import {
  type CoderPhaseOutput,
  type ReviewResult,
  type ReviewerInput,
  type SpecPhaseOutput,
  reviewResultSchema,
  reviewerInputSchema,
} from "../../agents/contracts/index.js";
import {
  runSpecPhase as runSpecPhaseImpl,
  specPhaseInputSchema,
} from "../../agents/spec/activity.js";
import type { SpecPhaseInput } from "../../agents/spec/activity.js";
import { runCoderPhase as runCoderPhaseImpl } from "../../agents/coder/activity.js";

export { specPhaseInputSchema };
export type { SpecPhaseInput };

// Heartbeat once at the start of each no-op phase so the activity body is on
// record with Temporal as a heartbeat-emitting activity. Real phase bodies
// (spec-agent / coder-agent / review-agent) emit heartbeats on a schedule that
// fits within the configured heartbeatTimeout (see dispatch.ts).
function heartbeatStart(detail: Record<string, unknown>): void {
  // Context.current() throws if called outside an activity (e.g. unit tests
  // that call runSpecPhase directly). Treat that as a noop.
  try {
    Context.current().heartbeat(detail);
  } catch {
    // not running inside an activity context
  }
}

// Real spec activity body lives in `agents/spec/activity.ts`. Re-exported here
// so the worker registry / dispatch wiring keeps importing from the same path.
export const runSpecPhase = runSpecPhaseImpl;
export const runCoderPhase = runCoderPhaseImpl;

export async function runReviewPhase(input: ReviewerInput): Promise<ReviewResult> {
  const validatedInput = reviewerInputSchema.parse(input);
  heartbeatStart({ phase: "review", ticketId: validatedInput.ticket.id });
  console.info("runReviewPhase noop", { ticketId: validatedInput.ticket.id });

  const output = {
    verdict: "approve" as const,
    reasoning: `No-op reviewer approved ${validatedInput.ticket.identifier}`,
    findings: [],
  };

  return reviewResultSchema.parse(output);
}
