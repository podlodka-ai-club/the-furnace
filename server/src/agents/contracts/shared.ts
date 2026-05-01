import { z } from "zod";

const shaPattern = /^[a-f0-9]{40}$/i;

export const subTicketRefSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
});

export type SubTicketRef = z.infer<typeof subTicketRefSchema>;

export const diffStatSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export type DiffStat = z.infer<typeof diffStatSchema>;

export const testRunSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  })
  .superRefine((summary, ctx) => {
    if (summary.passed + summary.failed > summary.total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Passed plus failed tests cannot exceed total tests",
      });
    }
  });

export type TestRunSummary = z.infer<typeof testRunSummarySchema>;

export const commitShaSchema = z.string().regex(shaPattern, "Expected a 40-character git SHA");

export const diffManifestFileSchema = z.object({
  path: z.string().min(1),
  changeType: z.enum(["A", "M", "D", "R"]),
});

export const diffManifestSchema = z.object({
  baseCommitSha: commitShaSchema,
  headCommitSha: commitShaSchema,
  files: z.array(diffManifestFileSchema),
});

export type DiffManifestFile = z.infer<typeof diffManifestFileSchema>;
export type DiffManifest = z.infer<typeof diffManifestSchema>;
