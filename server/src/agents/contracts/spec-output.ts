import { z } from "zod";
import { commitShaSchema, subTicketRefSchema } from "./shared.js";

export const specTestCommitSchema = z.object({
  sha: commitShaSchema,
  path: z.string().min(1),
  description: z.string().min(1),
});

export const implementationPlanAreaSchema = z.enum([
  "backend",
  "frontend",
  "config",
  "migration",
  "docs",
  "other",
]);

export const implementationPlanWorkItemSchema = z.object({
  area: implementationPlanAreaSchema,
  description: z.string().min(1),
  coveredByTests: z.boolean(),
});

export const implementationPlanSchema = z.object({
  summary: z.string().min(1),
  workItems: z.array(implementationPlanWorkItemSchema).min(1),
});

export const specPhaseOutputSchema = z.object({
  featureBranch: z.string().min(1),
  testCommits: z.array(specTestCommitSchema).min(1),
  implementationPlan: implementationPlanSchema,
  acClarification: subTicketRefSchema.optional(),
});

export type SpecTestCommit = z.infer<typeof specTestCommitSchema>;
export type ImplementationPlanArea = z.infer<typeof implementationPlanAreaSchema>;
export type ImplementationPlanWorkItem = z.infer<typeof implementationPlanWorkItemSchema>;
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type SpecPhaseOutput = z.infer<typeof specPhaseOutputSchema>;
