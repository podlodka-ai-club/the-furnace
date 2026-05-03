import { z } from "zod";
import { subTicketRefSchema } from "./shared.js";

export const clarificationAnswerSchema = z.object({
  answer: z.string().min(1),
  resolvedBy: z.string().min(1).optional(),
});

export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export const priorClarificationSchema = z.object({
  reason: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
  answer: z.string().min(1),
  resolvedBy: z.string().min(1).optional(),
});

export type PriorClarification = z.infer<typeof priorClarificationSchema>;

// Inner shape is defined separately so `CurrentClarification` describes the
// non-empty payload; the exported schema accepts `undefined` to match the
// query handler's contract (returns `undefined` before/after a wait).
const currentClarificationShapeSchema = z.object({
  subTicketRef: subTicketRefSchema,
  reason: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
  askedAt: z.string().min(1),
});

export type CurrentClarification = z.infer<typeof currentClarificationShapeSchema>;

export const currentClarificationSchema = currentClarificationShapeSchema.optional();
