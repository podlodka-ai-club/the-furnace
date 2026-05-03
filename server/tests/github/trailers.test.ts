import { describe, expect, it } from "vitest";
import {
  buildPrBody,
  buildPrTitle,
  formatDiffSummary,
  FURNACE_METADATA_CLOSE,
  FURNACE_METADATA_OPEN,
} from "../../src/github/trailers.js";
import { formatPlanAsMarkdown } from "../../src/agents/shared/plan-format.js";
import type { ImplementationPlan } from "../../src/agents/contracts/spec-output.js";

const SAMPLE_PLAN: ImplementationPlan = {
  summary: "Add an export feature backed by a typed POST /export route.",
  workItems: [
    {
      area: "backend",
      description: "Add POST /export streaming a CSV.",
      coveredByTests: true,
    },
    {
      area: "frontend",
      description: "Add Export button on the dashboard.",
      coveredByTests: false,
    },
  ],
};

describe("buildPrTitle", () => {
  it("returns the combined title verbatim when within 72 chars", () => {
    const title = buildPrTitle("ENG-123", "Add export to CSV");
    expect(title).toBe("ENG-123: Add export to CSV");
    expect(title.length).toBeLessThanOrEqual(72);
  });

  it("returns the combined title verbatim when exactly 72 chars", () => {
    const ticketTitle = "x".repeat(72 - "ENG-123: ".length);
    const title = buildPrTitle("ENG-123", ticketTitle);
    expect(title.length).toBe(72);
    expect(title.endsWith("…")).toBe(false);
  });

  it("truncates with an ellipsis when the combined title exceeds 72 chars", () => {
    const ticketTitle = "x".repeat(200);
    const title = buildPrTitle("ENG-123", ticketTitle);
    expect(title.length).toBe(72);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("ENG-123: ")).toBe(true);
  });
});

describe("formatDiffSummary", () => {
  it("uses 'files' (plural) when filesChanged is not 1", () => {
    expect(formatDiffSummary({ filesChanged: 2, insertions: 7, deletions: 1 })).toBe(
      "2 files changed, +7/-1",
    );
    expect(formatDiffSummary({ filesChanged: 0, insertions: 0, deletions: 0 })).toBe(
      "0 files changed, +0/-0",
    );
  });

  it("uses 'file' (singular) when filesChanged is 1", () => {
    expect(formatDiffSummary({ filesChanged: 1, insertions: 3, deletions: 0 })).toBe(
      "1 file changed, +3/-0",
    );
  });
});

describe("buildPrBody", () => {
  const baseArgs = {
    ticketDescription: "User-facing description goes here",
    implementationPlan: SAMPLE_PLAN,
    diffSummary: "2 files changed, +7/-1",
    workflowDeepLink: "http://localhost:8233/namespaces/default/workflows/ticket-issue_5",
    metadata: {
      workflowId: "ticket-issue_5",
      ticketId: "issue_5",
      ticketIdentifier: "ENG-5",
      attemptCount: 1,
      model: "claude-opus-4-7",
      finalCommit: "f".repeat(40),
    },
  };

  it("includes the ticket description verbatim", () => {
    const body = buildPrBody(baseArgs);
    expect(body).toContain("User-facing description goes here");
  });

  it("includes the diff summary line", () => {
    const body = buildPrBody(baseArgs);
    expect(body).toMatch(/\*\*Diff:\*\* 2 files changed, \+7\/-1/);
  });

  it("includes the workflow deep link", () => {
    const body = buildPrBody(baseArgs);
    expect(body).toContain(baseArgs.workflowDeepLink);
  });

  it("contains exactly one `## Implementation plan` heading", () => {
    const body = buildPrBody(baseArgs);
    const matches = body.match(/^## Implementation plan$/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("renders the plan via formatPlanAsMarkdown verbatim", () => {
    const body = buildPrBody(baseArgs);
    expect(body).toContain(formatPlanAsMarkdown(SAMPLE_PLAN));
  });

  it("places the plan section after the ticket description and before the diff summary", () => {
    const body = buildPrBody(baseArgs);
    const descIdx = body.indexOf("User-facing description goes here");
    const planIdx = body.indexOf("## Implementation plan");
    const diffIdx = body.indexOf("**Diff:**");
    expect(descIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(descIdx);
    expect(diffIdx).toBeGreaterThan(planIdx);
  });

  it("emits a single metadata block with all six required keys in order", () => {
    const body = buildPrBody(baseArgs);
    const openIdx = body.indexOf(FURNACE_METADATA_OPEN);
    const closeIdx = body.indexOf(FURNACE_METADATA_CLOSE);
    expect(openIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(openIdx);

    const block = body.slice(openIdx, closeIdx + FURNACE_METADATA_CLOSE.length);
    const lines = block.split("\n");
    // Lines: <open>, Workflow-Id, Ticket-Id, Ticket-Identifier, Attempt-Count, Model, Final-Commit, <close>
    expect(lines[0]).toBe(FURNACE_METADATA_OPEN);
    expect(lines[1]).toBe("Workflow-Id: ticket-issue_5");
    expect(lines[2]).toBe("Ticket-Id: issue_5");
    expect(lines[3]).toBe("Ticket-Identifier: ENG-5");
    expect(lines[4]).toBe("Attempt-Count: 1");
    expect(lines[5]).toBe("Model: claude-opus-4-7");
    expect(lines[6]).toBe(`Final-Commit: ${"f".repeat(40)}`);
    expect(lines[7]).toBe(FURNACE_METADATA_CLOSE);
  });

  it("omits the description block when description is blank", () => {
    const body = buildPrBody({ ...baseArgs, ticketDescription: "" });
    expect(body.startsWith("## Implementation plan")).toBe(true);
  });
});
