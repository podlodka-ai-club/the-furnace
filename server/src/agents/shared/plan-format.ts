import type {
  ImplementationPlan,
  ImplementationPlanArea,
} from "../contracts/index.js";

const AREA_ORDER: ReadonlyArray<ImplementationPlanArea> = [
  "backend",
  "frontend",
  "config",
  "migration",
  "docs",
  "other",
];

const AREA_TITLE: Record<ImplementationPlanArea, string> = {
  backend: "Backend",
  frontend: "Frontend",
  config: "Config",
  migration: "Migration",
  docs: "Docs",
  other: "Other",
};

export function formatPlanAsMarkdown(plan: ImplementationPlan): string {
  const lines: string[] = [];
  lines.push("## Implementation plan");
  lines.push("");
  lines.push(plan.summary.trim());

  for (const area of AREA_ORDER) {
    const items = plan.workItems.filter((item) => item.area === area);
    if (items.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`### ${AREA_TITLE[area]}`);
    lines.push("");
    for (const item of items) {
      const tag = item.coveredByTests ? "(test-covered)" : "(plan-only)";
      lines.push(`- ${tag} ${item.description.trim()}`);
    }
  }

  return lines.join("\n");
}
