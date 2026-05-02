import { z } from "zod";

// Argument schemas for the three custom tools the coder agent is allowed to
// call. The Claude Agent SDK enforces these against the model's tool-call
// payloads, and the activity uses them again as a defense-in-depth parse
// before acting on the input.

export const submitImplementationArgsSchema = z.object({
  summary: z.string().min(1),
});

export type SubmitImplementationArgs = z.infer<typeof submitImplementationArgsSchema>;

export const reportDepMissingArgsSchema = z.object({
  reason: z.string().min(1),
  dependency: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
});

export type ReportDepMissingArgs = z.infer<typeof reportDepMissingArgsSchema>;

export const reportDesignQuestionArgsSchema = z.object({
  reason: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
});

export type ReportDesignQuestionArgs = z.infer<typeof reportDesignQuestionArgsSchema>;

export const CODER_TOOL_NAMES = {
  submitImplementation: "submit_implementation",
  reportDepMissing: "report_dep_missing",
  reportDesignQuestion: "report_design_question",
} as const;

export type CoderToolName = (typeof CODER_TOOL_NAMES)[keyof typeof CODER_TOOL_NAMES];
