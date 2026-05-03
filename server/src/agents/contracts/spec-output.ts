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

export const awaitingClarificationResultSchema = z.object({
  kind: z.literal("awaiting_clarification"),
  subTicketRef: subTicketRefSchema,
  reason: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
});

export const specPhaseResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("done"),
    output: specPhaseOutputSchema,
  }),
  awaitingClarificationResultSchema,
]);

export type SpecTestCommit = z.infer<typeof specTestCommitSchema>;
export type ImplementationPlanArea = z.infer<typeof implementationPlanAreaSchema>;
export type ImplementationPlanWorkItem = z.infer<typeof implementationPlanWorkItemSchema>;
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type SpecPhaseOutput = z.infer<typeof specPhaseOutputSchema>;
export type AwaitingClarificationResult = z.infer<typeof awaitingClarificationResultSchema>;
export type SpecPhaseResult = z.infer<typeof specPhaseResultSchema>;
