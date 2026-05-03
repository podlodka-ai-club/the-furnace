import { describe, expect, it } from "vitest";
import { formatPlanAsMarkdown } from "../../../src/agents/shared/plan-format.js";
import type { ImplementationPlan } from "../../../src/agents/contracts/index.js";

const SAMPLE_PLAN: ImplementationPlan = {
  summary: "Add export capability across backend and frontend.",
  workItems: [
    {
      area: "backend",
      description: "Add POST /export route streaming CSV.",
      coveredByTests: true,
    },
    {
      area: "frontend",
      description: "Add Export button to dashboard.",
      coveredByTests: false,
    },
    {
      area: "docs",
      description: "Document the new endpoint in README.",
      coveredByTests: false,
    },
  ],
};

describe("formatPlanAsMarkdown", () => {
  it("emits the `## Implementation plan` heading exactly once at the start", () => {
    const md = formatPlanAsMarkdown(SAMPLE_PLAN);
    expect(md.startsWith("## Implementation plan\n")).toBe(true);
    const matches = md.match(/^## Implementation plan$/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("includes the summary verbatim under the heading", () => {
    const md = formatPlanAsMarkdown(SAMPLE_PLAN);
    expect(md).toContain(SAMPLE_PLAN.summary);
  });

  it("annotates each item with (test-covered) or (plan-only) per coveredByTests", () => {
    const md = formatPlanAsMarkdown(SAMPLE_PLAN);
    expect(md).toContain("- (test-covered) Add POST /export route streaming CSV.");
    expect(md).toContain("- (plan-only) Add Export button to dashboard.");
    expect(md).toContain("- (plan-only) Document the new endpoint in README.");
  });

  it("groups items by area under H3 headings", () => {
    const md = formatPlanAsMarkdown(SAMPLE_PLAN);
    expect(md).toContain("### Backend");
    expect(md).toContain("### Frontend");
    expect(md).toContain("### Docs");
  });

  it("omits area sections that have no items", () => {
    const md = formatPlanAsMarkdown(SAMPLE_PLAN);
    expect(md).not.toContain("### Config");
    expect(md).not.toContain("### Migration");
    expect(md).not.toContain("### Other");
  });

  it("is byte-identical across calls (deterministic output)", () => {
    const a = formatPlanAsMarkdown(SAMPLE_PLAN);
    const b = formatPlanAsMarkdown(SAMPLE_PLAN);
    expect(a).toBe(b);
  });

  it("renders areas in stable order regardless of input order", () => {
    const reordered: ImplementationPlan = {
      summary: "x",
      workItems: [
        { area: "other", description: "z", coveredByTests: false },
        { area: "docs", description: "y", coveredByTests: false },
        { area: "frontend", description: "x", coveredByTests: false },
        { area: "migration", description: "w", coveredByTests: false },
        { area: "config", description: "v", coveredByTests: false },
        { area: "backend", description: "u", coveredByTests: false },
      ],
    };
    const md = formatPlanAsMarkdown(reordered);
    const idx = (heading: string) => md.indexOf(heading);
    expect(idx("### Backend")).toBeGreaterThan(-1);
    expect(idx("### Backend")).toBeLessThan(idx("### Frontend"));
    expect(idx("### Frontend")).toBeLessThan(idx("### Config"));
    expect(idx("### Config")).toBeLessThan(idx("### Migration"));
    expect(idx("### Migration")).toBeLessThan(idx("### Docs"));
    expect(idx("### Docs")).toBeLessThan(idx("### Other"));
  });

  it("preserves submission order within an area", () => {
    const plan: ImplementationPlan = {
      summary: "ordered",
      workItems: [
        { area: "backend", description: "first", coveredByTests: true },
        { area: "backend", description: "second", coveredByTests: false },
        { area: "backend", description: "third", coveredByTests: true },
      ],
    };
    const md = formatPlanAsMarkdown(plan);
    const firstIdx = md.indexOf("first");
    const secondIdx = md.indexOf("second");
    const thirdIdx = md.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});
