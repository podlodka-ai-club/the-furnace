import { z } from "zod";
import { commitShaSchema, subTicketRefSchema } from "./shared.js";

export const specTestCommitSchema = z.object({
  sha: commitShaSchema,
  path: z.string().min(1),
  description: z.string().min(1),
});

export const specPhaseOutputSchema = z.object({
  featureBranch: z.string().min(1),
  testCommits: z.array(specTestCommitSchema).min(1),
  acClarification: subTicketRefSchema.optional(),
});

export type SpecTestCommit = z.infer<typeof specTestCommitSchema>;
export type SpecPhaseOutput = z.infer<typeof specPhaseOutputSchema>;
