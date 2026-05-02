import { z } from "zod";
import { commitShaSchema, diffStatSchema, testRunSummarySchema } from "./shared.js";

export const reviewerTicketSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
});

export const reviewerInputSchema = z.object({
  ticket: reviewerTicketSchema,
  featureBranch: z.string().min(1),
  finalCommitSha: commitShaSchema,
  diffStat: diffStatSchema,
  testRunSummary: testRunSummarySchema,
});

export const reviewVerdictSchema = z.enum(["approve", "changes_requested"]);

export const reviewResultSchema = z.object({
  verdict: reviewVerdictSchema,
  reasoning: z.string().min(1),
  findings: z.array(z.string().min(1)),
});

export type ReviewerTicket = z.infer<typeof reviewerTicketSchema>;
export type ReviewerInput = z.infer<typeof reviewerInputSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
