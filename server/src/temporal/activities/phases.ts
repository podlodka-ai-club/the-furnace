import { Context } from "@temporalio/activity";
import {
  type CoderPhaseOutput,
  type ReviewResult,
  type ReviewerInput,
  type ReviewerTicket,
  type SpecPhaseOutput,
  coderPhaseOutputSchema,
  reviewResultSchema,
  reviewerInputSchema,
  reviewerTicketSchema,
  specPhaseOutputSchema,
} from "../../agents/contracts/index.js";
import { z } from "zod";

export const specPhaseInputSchema = z.object({
  ticket: reviewerTicketSchema,
});

export interface SpecPhaseInput {
  ticket: ReviewerTicket;
}

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

export async function runSpecPhase(input: SpecPhaseInput): Promise<SpecPhaseOutput> {
  const validatedInput = specPhaseInputSchema.parse(input);
  heartbeatStart({ phase: "spec", ticketId: validatedInput.ticket.id });
  console.info("runSpecPhase noop", { ticketId: validatedInput.ticket.id });

  const output = {
    featureBranch: `agent/spec-${validatedInput.ticket.identifier.toLowerCase()}`,
    testCommits: [
      {
        sha: "a".repeat(40),
        path: "server/tests/integration/ticket.acceptance.test.ts",
        description: `Failing acceptance tests for ${validatedInput.ticket.identifier}`,
      },
    ],
  };

  return specPhaseOutputSchema.parse(output);
}

export async function runCoderPhase(input: SpecPhaseOutput): Promise<CoderPhaseOutput> {
  const validatedInput = specPhaseOutputSchema.parse(input);
  heartbeatStart({ phase: "coder", featureBranch: validatedInput.featureBranch });
  console.info("runCoderPhase noop", { featureBranch: validatedInput.featureBranch });

  const output = {
    featureBranch: validatedInput.featureBranch,
    finalCommitSha: "b".repeat(40),
    diffStat: {
      filesChanged: 1,
      insertions: 10,
      deletions: 0,
    },
    testRunSummary: {
      total: 1,
      passed: 1,
      failed: 0,
      durationMs: 1000,
    },
  };

  return coderPhaseOutputSchema.parse(output);
}

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
