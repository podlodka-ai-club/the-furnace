import { z } from "zod";
import { findingSchema } from "../contracts/reviewer-io.js";

// The reviewer finishes by calling exactly one of these tools. `submit_review`
// is the terminal happy-path tool; its args mirror `reviewResultSchema` so the
// activity can parse the SDK's tool-call payload directly.

export const submitReviewArgsSchema = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  reasoning: z.string().min(1),
  findings: z.array(findingSchema),
});

export type SubmitReviewArgs = z.infer<typeof submitReviewArgsSchema>;

export const REVIEW_TOOL_NAMES = {
  submitReview: "submit_review",
} as const;

export type ReviewToolName = (typeof REVIEW_TOOL_NAMES)[keyof typeof REVIEW_TOOL_NAMES];
