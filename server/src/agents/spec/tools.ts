import { z } from "zod";

// Argument schemas for the two custom tools the spec agent is allowed to call.
// The Claude Agent SDK enforces these against the model's tool-call payloads,
// and the activity uses them again as a defense-in-depth parse before acting on
// the input.

export const proposeFailingTestsArgsSchema = z.object({
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .refine((p) => !p.startsWith("/") && !p.includes(".."), {
            message: "path must be relative to the repo root and must not traverse upward",
          }),
        contents: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .min(1),
});

export type ProposeFailingTestsArgs = z.infer<typeof proposeFailingTestsArgsSchema>;

export const requestAcClarificationArgsSchema = z.object({
  reason: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
});

export type RequestAcClarificationArgs = z.infer<typeof requestAcClarificationArgsSchema>;

export const SPEC_TOOL_NAMES = {
  proposeFailingTests: "propose_failing_tests",
  requestAcClarification: "request_ac_clarification",
} as const;

export type SpecToolName = (typeof SPEC_TOOL_NAMES)[keyof typeof SPEC_TOOL_NAMES];
