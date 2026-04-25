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

export async function runSpecPhase(input: SpecPhaseInput): Promise<SpecPhaseOutput> {
  const validatedInput = specPhaseInputSchema.parse(input);

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

  const output = {
    verdict: "approve" as const,
    reasoning: `No-op reviewer approved ${validatedInput.ticket.identifier}`,
    findings: [],
  };

  return reviewResultSchema.parse(output);
}
