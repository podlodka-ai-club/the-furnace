import { z } from "zod";
import {
  commitShaSchema,
  diffStatSchema,
  subTicketRefSchema,
  testRunSummarySchema,
} from "./shared.js";

export const coderPhaseOutputSchema = z.object({
  featureBranch: z.string().min(1),
  finalCommitSha: commitShaSchema,
  diffStat: diffStatSchema,
  testRunSummary: testRunSummarySchema,
  escalation: subTicketRefSchema.optional(),
});

export type CoderPhaseOutput = z.infer<typeof coderPhaseOutputSchema>;
