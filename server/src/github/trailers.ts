import type { ImplementationPlan } from "../agents/contracts/spec-output.js";
import { formatPlanAsMarkdown } from "../agents/shared/plan-format.js";

const PR_TITLE_MAX_LENGTH = 72;
const ELLIPSIS = "…";

export function buildPrTitle(ticketIdentifier: string, ticketTitle: string): string {
  const combined = `${ticketIdentifier}: ${ticketTitle}`;
  if (combined.length <= PR_TITLE_MAX_LENGTH) {
    return combined;
  }
  return combined.slice(0, PR_TITLE_MAX_LENGTH - ELLIPSIS.length) + ELLIPSIS;
}

export interface PrBodyMetadata {
  workflowId: string;
  ticketId: string;
  ticketIdentifier: string;
  attemptCount: number;
  model: string;
  finalCommit: string;
}

export interface BuildPrBodyArgs {
  ticketDescription: string;
  implementationPlan: ImplementationPlan;
  diffSummary: string;
  workflowDeepLink: string;
  metadata: PrBodyMetadata;
}

export const FURNACE_METADATA_OPEN = "<!-- furnace:metadata -->";
export const FURNACE_METADATA_CLOSE = "<!-- /furnace:metadata -->";

export function buildPrBody(args: BuildPrBodyArgs): string {
  const description = args.ticketDescription.trim();
  const lines: string[] = [];
  if (description.length > 0) {
    lines.push(description, "");
  }
  lines.push(formatPlanAsMarkdown(args.implementationPlan));
  lines.push("");
  lines.push(`**Diff:** ${args.diffSummary}`);
  lines.push(`**Workflow:** ${args.workflowDeepLink}`);
  lines.push("");
  lines.push(FURNACE_METADATA_OPEN);
  lines.push(`Workflow-Id: ${args.metadata.workflowId}`);
  lines.push(`Ticket-Id: ${args.metadata.ticketId}`);
  lines.push(`Ticket-Identifier: ${args.metadata.ticketIdentifier}`);
  lines.push(`Attempt-Count: ${args.metadata.attemptCount}`);
  lines.push(`Model: ${args.metadata.model}`);
  lines.push(`Final-Commit: ${args.metadata.finalCommit}`);
  lines.push(FURNACE_METADATA_CLOSE);
  return lines.join("\n");
}

export interface DiffStatLike {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export function formatDiffSummary(stat: DiffStatLike): string {
  const fileNoun = stat.filesChanged === 1 ? "file" : "files";
  return `${stat.filesChanged} ${fileNoun} changed, +${stat.insertions}/-${stat.deletions}`;
}
