import { describe, expect, it } from "vitest";
import {
  coderPhaseOutputSchema,
  reviewResultSchema,
  reviewerInputSchema,
  specPhaseOutputSchema,
} from "../../../src/agents/contracts/index.js";
import {
  runCoderPhase,
  runReviewPhase,
  runSpecPhase,
  specPhaseInputSchema,
} from "../../../src/temporal/activities/phases.js";

describe("phase activities contract boundaries", () => {
  it("returns spec phase output that passes schema validation", async () => {
    const input = specPhaseInputSchema.parse({
      ticket: {
        id: "ticket_1",
        identifier: "ENG-123",
        title: "Agent IO contracts",
      },
    });

    const output = await runSpecPhase(input);
    expect(specPhaseOutputSchema.parse(output)).toEqual(output);
  });

  it("returns coder phase output that passes schema validation", async () => {
    const specOutput = specPhaseOutputSchema.parse({
      featureBranch: "agent/spec-eng-123",
      testCommits: [
        {
          sha: "a".repeat(40),
          path: "server/tests/integration/sample.test.ts",
          description: "Add failing acceptance criteria tests",
        },
      ],
    });

    const output = await runCoderPhase(specOutput);
    expect(coderPhaseOutputSchema.parse(output)).toEqual(output);
  });

  it("returns review result that passes schema validation", async () => {
    const reviewerInput = reviewerInputSchema.parse({
      ticket: {
        id: "ticket_1",
        identifier: "ENG-123",
        title: "Agent IO contracts",
      },
      featureBranch: "agent/spec-eng-123",
      finalCommitSha: "b".repeat(40),
      diffStat: { filesChanged: 2, insertions: 10, deletions: 1 },
      testRunSummary: { total: 2, passed: 2, failed: 0, durationMs: 1200 },
    });

    const output = await runReviewPhase(reviewerInput);
    expect(reviewResultSchema.parse(output)).toEqual(output);
  });
});
