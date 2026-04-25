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
});
