import { z } from "zod";

export const CODER_TOOL_NAMES = {
  reportAttemptResult: "report_attempt_result",
} as const;

export const reportAttemptResultArgsSchema = z.object({
  status: z.enum(["success", "retry", "dep-missing", "design-question"]),
  reason: z.string().trim().min(1).optional(),
});
