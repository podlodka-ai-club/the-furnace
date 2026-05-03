import { z } from "zod";
import { commitShaSchema, diffStatSchema, testRunSummarySchema } from "./shared.js";

export const reviewerTicketSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
});

export const findingSeveritySchema = z.enum(["blocking", "advisory"]);

export const findingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: findingSeveritySchema,
  message: z.string().min(1),
});

export const reviewerInputSchema = z.object({
  ticket: reviewerTicketSchema,
  featureBranch: z.string().min(1),
  finalCommitSha: commitShaSchema,
  diffStat: diffStatSchema,
  testRunSummary: testRunSummarySchema,
  prNumber: z.number().int().positive(),
  round: z.number().int().nonnegative(),
});

export const reviewVerdictSchema = z.enum(["approve", "changes_requested"]);

export const reviewResultSchema = z
  .object({
    verdict: reviewVerdictSchema,
    reasoning: z.string().min(1),
    findings: z.array(findingSchema),
  })
  .superRefine((result, ctx) => {
    // Spec invariants (single-review-with-feedback-loop):
    //   - `approve` verdict: every finding present MUST have severity `advisory`.
    //   - `changes_requested` verdict: at least one finding MUST have severity `blocking`.
    if (result.verdict === "approve") {
      const hasBlocking = result.findings.some((f) => f.severity === "blocking");
      if (hasBlocking) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "approve verdict cannot include blocking findings",
        });
      }
    } else if (result.verdict === "changes_requested") {
      const hasBlocking = result.findings.some((f) => f.severity === "blocking");
      if (!hasBlocking) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "changes_requested verdict requires at least one blocking finding",
        });
      }
    }
  });

export const priorReviewSchema = z.object({
  prNumber: z.number().int().positive(),
  reviewSummary: z.string().min(1),
  findings: z.array(findingSchema),
});

export type ReviewerTicket = z.infer<typeof reviewerTicketSchema>;
export type ReviewerInput = z.infer<typeof reviewerInputSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;
export type Finding = z.infer<typeof findingSchema>;
export type PriorReview = z.infer<typeof priorReviewSchema>;
