import { describe, expect, it } from "vitest";
import {
  coderPhaseOutputSchema,
  diffStatSchema,
  reviewResultSchema,
  reviewerInputSchema,
  specPhaseOutputSchema,
  subTicketRefSchema,
  testRunSummarySchema,
} from "../../../src/agents/contracts/index.js";
import { coderPhaseInputSchema } from "../../../src/agents/coder/activity.js";
import {
  invalidCoderPhaseOutput,
  invalidDiffStat,
  invalidReviewResult,
  invalidReviewerInput,
  invalidSpecPhaseOutput,
  invalidSubTicketRef,
  invalidTestRunSummary,
  validCoderPhaseOutput,
  validDiffStat,
  validReviewResult,
  validReviewerInput,
  validSpecPhaseOutput,
  validSubTicketRef,
  validTestRunSummary,
} from "./fixtures.js";

describe("agent contracts", () => {
  it("parses valid shared fixtures", () => {
    expect(subTicketRefSchema.parse(validSubTicketRef)).toEqual(validSubTicketRef);
    expect(diffStatSchema.parse(validDiffStat)).toEqual(validDiffStat);
    expect(testRunSummarySchema.parse(validTestRunSummary)).toEqual(validTestRunSummary);
  });

  it("rejects invalid shared fixtures", () => {
    expect(() => subTicketRefSchema.parse(invalidSubTicketRef)).toThrow();
    expect(() => diffStatSchema.parse(invalidDiffStat)).toThrow();
    expect(() => testRunSummarySchema.parse(invalidTestRunSummary)).toThrow();
  });

  it("parses valid phase fixtures", () => {
    expect(specPhaseOutputSchema.parse(validSpecPhaseOutput)).toEqual(validSpecPhaseOutput);
    expect(coderPhaseOutputSchema.parse(validCoderPhaseOutput)).toEqual(validCoderPhaseOutput);
    expect(reviewerInputSchema.parse(validReviewerInput)).toEqual(validReviewerInput);
    expect(reviewResultSchema.parse(validReviewResult)).toEqual(validReviewResult);
  });

  it("rejects invalid phase fixtures", () => {
    expect(() => specPhaseOutputSchema.parse(invalidSpecPhaseOutput)).toThrow();
    expect(() => coderPhaseOutputSchema.parse(invalidCoderPhaseOutput)).toThrow();
    expect(() => reviewerInputSchema.parse(invalidReviewerInput)).toThrow();
    expect(() => reviewResultSchema.parse(invalidReviewResult)).toThrow();
  });

  describe("reviewResultSchema verdict/severity invariants", () => {
    it("accepts approve with no findings", () => {
      const result = {
        verdict: "approve" as const,
        reasoning: "Looks good.",
        findings: [],
      };
      expect(reviewResultSchema.parse(result)).toEqual(result);
    });

    it("accepts approve with advisory-only findings", () => {
      const result = {
        verdict: "approve" as const,
        reasoning: "Minor suggestions.",
        findings: [
          {
            path: "src/foo.ts",
            severity: "advisory" as const,
            message: "Consider extracting helper",
          },
        ],
      };
      expect(reviewResultSchema.parse(result)).toEqual(result);
    });

    it("rejects approve with blocking findings", () => {
      const result = {
        verdict: "approve" as const,
        reasoning: "Approved despite issues.",
        findings: [
          {
            path: "src/foo.ts",
            severity: "blocking" as const,
            message: "Null check missing",
          },
        ],
      };
      expect(() => reviewResultSchema.parse(result)).toThrow(
        /approve verdict cannot include blocking findings/,
      );
    });

    it("accepts changes_requested with at least one blocking finding", () => {
      const result = {
        verdict: "changes_requested" as const,
        reasoning: "Two issues to fix.",
        findings: [
          {
            path: "src/foo.ts",
            line: 12,
            severity: "blocking" as const,
            message: "Race condition",
          },
          {
            path: "src/bar.ts",
            severity: "advisory" as const,
            message: "Style nit",
          },
        ],
      };
      expect(reviewResultSchema.parse(result)).toEqual(result);
    });

    it("rejects changes_requested with no blocking findings", () => {
      const result = {
        verdict: "changes_requested" as const,
        reasoning: "Asked for changes but only advisory.",
        findings: [
          {
            path: "src/foo.ts",
            severity: "advisory" as const,
            message: "Consider renaming",
          },
        ],
      };
      expect(() => reviewResultSchema.parse(result)).toThrow(
        /changes_requested verdict requires at least one blocking finding/,
      );
    });

    it("rejects changes_requested with empty findings", () => {
      const result = {
        verdict: "changes_requested" as const,
        reasoning: "Need work.",
        findings: [],
      };
      expect(() => reviewResultSchema.parse(result)).toThrow(
        /changes_requested verdict requires at least one blocking finding/,
      );
    });

    it("rejects malformed finding shapes", () => {
      expect(() =>
        reviewResultSchema.parse({
          verdict: "approve",
          reasoning: "ok",
          findings: [{ path: "", severity: "blocking", message: "" }],
        }),
      ).toThrow();
    });
  });

  describe("coderPhaseInputSchema priorReview", () => {
    const baseInput = {
      ticket: {
        id: "ticket_1",
        identifier: "ENG-123",
        title: "Implement feature",
        description: "Do the thing.",
      },
      specOutput: validSpecPhaseOutput,
    };

    it("parses round-0 input without priorReview", () => {
      const parsed = coderPhaseInputSchema.parse(baseInput);
      expect(parsed.priorReview).toBeUndefined();
    });

    it("parses follow-up input with valid priorReview", () => {
      const parsed = coderPhaseInputSchema.parse({
        ...baseInput,
        priorReview: {
          prNumber: 17,
          reviewSummary: "Two issues to fix.",
          findings: [
            {
              path: "src/foo.ts",
              line: 12,
              severity: "blocking" as const,
              message: "Race condition",
            },
          ],
        },
      });
      expect(parsed.priorReview?.prNumber).toBe(17);
      expect(parsed.priorReview?.findings).toHaveLength(1);
    });

    it("rejects malformed priorReview", () => {
      expect(() =>
        coderPhaseInputSchema.parse({
          ...baseInput,
          priorReview: {
            prNumber: -1,
            reviewSummary: "",
            findings: [],
          },
        }),
      ).toThrow();
    });

    it("rejects priorReview with malformed finding", () => {
      expect(() =>
        coderPhaseInputSchema.parse({
          ...baseInput,
          priorReview: {
            prNumber: 17,
            reviewSummary: "ok",
            findings: [{ path: "", severity: "blocking", message: "x" }],
          },
        }),
      ).toThrow();
    });
  });
});
