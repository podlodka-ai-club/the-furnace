import { z } from "zod";
import {
  commitShaSchema,
  diffManifestSchema,
  diffStatSchema,
  subTicketRefSchema,
  testRunSummarySchema,
} from "./shared.js";

export const coderSuccessOutputSchema = z.object({
  status: z.literal("success"),
  featureBranch: z.string().min(1),
  finalCommitSha: commitShaSchema,
  diffManifest: diffManifestSchema,
  diffStat: diffStatSchema,
  testRunSummary: testRunSummarySchema,
});

export const coderStuckOutputSchema = z.object({
  status: z.literal("stuck"),
  featureBranch: z.string().min(1),
  stuckType: z.enum(["dep-missing", "design-question"]),
  subTicket: subTicketRefSchema,
});

export const coderPhaseOutputSchema = z.discriminatedUnion("status", [
  coderSuccessOutputSchema,
  coderStuckOutputSchema,
]);

export type CoderPhaseOutput = z.infer<typeof coderPhaseOutputSchema>;
export type CoderSuccessOutput = z.infer<typeof coderSuccessOutputSchema>;
export type CoderStuckOutput = z.infer<typeof coderStuckOutputSchema>;
