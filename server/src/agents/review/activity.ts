import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  reviewerInputSchema,
  reviewResultSchema,
  type ReviewerInput,
  type ReviewResult,
} from "../contracts/index.js";
import { readWorkerRepoPath } from "../../temporal/config.js";
import {
  checkoutFeatureBranch,
  computeChangedPaths,
  defaultRunCommand,
  getDefaultBranch,
  type GitOpsContext,
  type RunCommand,
} from "../shared/repo-ops.js";
import { defaultReviewAgentClient } from "./sdk-client.js";
import type {
  ReviewAgentClient,
  ReviewAgentDecision,
  ReviewAgentSession,
} from "./agent.js";

const HEARTBEAT_INTERVAL_MS = 5_000;

const REVIEWER_CORRECTION_BUDGET = 3;

export const REVIEW_FAILURE_TYPES = {
  invalidInput: "InvalidReviewerInput",
  invalidOutput: "InvalidReviewerOutput",
  toolBudgetExhausted: "ReviewAgentBudgetExhausted",
} as const;

export interface RunReviewAgentDeps {
  agentClient?: ReviewAgentClient;
  loadPrompt?: () => Promise<string>;
  resolveRepoPath?: () => string;
  runCommand?: RunCommand;
}

export async function runReviewAgent(
  input: ReviewerInput,
  deps: RunReviewAgentDeps = {},
): Promise<ReviewResult> {
  const validated = parseInput(input);
  heartbeat({ phase: "review", ticketId: validated.ticket.id, round: validated.round });

  const repoPath = (deps.resolveRepoPath ?? readWorkerRepoPath)();
  const agentClient = deps.agentClient ?? defaultReviewAgentClient;
  const loadPrompt = deps.loadPrompt ?? loadDefaultPrompt;
  const run = deps.runCommand ?? defaultRunCommand;

  const ops: GitOpsContext = { repoRoot: repoPath, run };
  heartbeat({ phase: "review", action: "checkout", branch: validated.featureBranch });
  await checkoutFeatureBranch(ops, validated.featureBranch);

  const defaultBranch = await getDefaultBranch(ops);
  const changedPaths = await computeChangedPaths(ops, `origin/${defaultBranch}`);

  const promptTemplate = await loadPrompt();
  const prompt = renderPrompt(promptTemplate, validated, repoPath, changedPaths);

  const raw = await driveAgentLoop(agentClient, prompt, repoPath, validated);
  return reconcileFindingsWithDiff(raw, changedPaths);
}

// Drop findings whose `path` is not part of the PR diff and fold their text
// into `reasoning` so the content survives. Without this, the reviewer agent
// can ignore the prompt's "only cite paths in the diff" rule, and the GitHub
// post-review activity then treats the resulting 422 as stale-line and drops
// ALL inline comments — losing valid findings together with the bad ones.
export function reconcileFindingsWithDiff(
  result: ReviewResult,
  changedPaths: ReadonlyArray<string>,
): ReviewResult {
  const allowed = new Set(changedPaths);
  const kept: typeof result.findings = [];
  const dropped: typeof result.findings = [];
  for (const f of result.findings) {
    if (allowed.has(f.path)) {
      kept.push(f);
    } else {
      dropped.push(f);
    }
  }
  if (dropped.length === 0) {
    return result;
  }
  const droppedLines = dropped.map((f) => {
    const loc = f.line !== undefined ? `${f.path}:${f.line}` : f.path;
    return `- [${f.severity}] ${loc} — ${f.message}`;
  });
  const augmentedReasoning = [
    result.reasoning.trim(),
    "",
    "**Out-of-diff notes** (cited paths are not part of this PR; folded into the body so the points are not lost):",
    droppedLines.join("\n"),
  ].join("\n");
  return { ...result, reasoning: augmentedReasoning, findings: kept };
}

function parseInput(input: ReviewerInput): ReviewerInput {
  const result = reviewerInputSchema.safeParse(input);
  if (!result.success) {
    throw ApplicationFailure.nonRetryable(
      `Invalid reviewer input: ${result.error.message}`,
      REVIEW_FAILURE_TYPES.invalidInput,
    );
  }
  return result.data;
}

async function driveAgentLoop(
  agentClient: ReviewAgentClient,
  prompt: string,
  repoPath: string,
  input: ReviewerInput,
): Promise<ReviewResult> {
  const abort = new AbortController();
  const heartbeatTimer = setInterval(
    () => heartbeat({ phase: "review", ticketId: input.ticket.id, round: input.round }),
    HEARTBEAT_INTERVAL_MS,
  );
  let session: ReviewAgentSession | null = null;
  let corrections = 0;
  try {
    session = await agentClient.startSession({
      systemPrompt: prompt,
      userPrompt: "Begin. Read the diff, investigate, and call submit_review once.",
      cwd: repoPath,
      signal: abort.signal,
    });

    let decision: ReviewAgentDecision = await session.next();
    while (true) {
      if (decision.type === "submit_review") {
        return finalizeOutput(decision.input);
      }
      if (corrections >= REVIEWER_CORRECTION_BUDGET) {
        throw ApplicationFailure.create({
          message: `Review agent exhausted correction budget (${REVIEWER_CORRECTION_BUDGET}) without submitting a review`,
          type: REVIEW_FAILURE_TYPES.toolBudgetExhausted,
          nonRetryable: false,
        });
      }
      corrections += 1;
      const nudge =
        decision.type === "malformed_tool_call"
          ? `Your last tool call had invalid arguments (${decision.error}). Re-call submit_review with a valid payload.`
          : "You ended your turn without calling a tool. You must call submit_review exactly once to finish.";
      decision = await session.next(nudge);
    }
  } finally {
    clearInterval(heartbeatTimer);
    // Close first so the SDK can flush the in-flight MCP tool ack write
    // before we abort. Aborting first kills the child process mid-write and
    // surfaces an unhandled AbortError from ProcessTransport.write.
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort cleanup
      }
    }
    abort.abort();
  }
}

function finalizeOutput(args: ReviewResult): ReviewResult {
  const result = reviewResultSchema.safeParse(args);
  if (!result.success) {
    throw ApplicationFailure.nonRetryable(
      `Reviewer produced invalid result: ${result.error.message}`,
      REVIEW_FAILURE_TYPES.invalidOutput,
    );
  }
  return result.data;
}

export function renderPrompt(
  template: string,
  input: ReviewerInput,
  repoPath: string,
  changedPaths: ReadonlyArray<string>,
): string {
  const diffStat = `${input.diffStat.filesChanged} files changed, +${input.diffStat.insertions}/-${input.diffStat.deletions}`;
  const testSummary = `${input.testRunSummary.passed}/${input.testRunSummary.total} tests passed (${input.testRunSummary.failed} failed) in ${input.testRunSummary.durationMs}ms`;
  const changedPathsBlock =
    changedPaths.length > 0
      ? changedPaths.map((p) => `- ${p}`).join("\n")
      : "(no paths reported by git diff — investigate with `git status` before submitting findings)";
  return template
    .replaceAll("{{TICKET_IDENTIFIER}}", input.ticket.identifier)
    .replaceAll("{{TICKET_TITLE}}", input.ticket.title)
    .replaceAll(
      "{{TICKET_DESCRIPTION}}",
      input.ticket.description.length > 0 ? input.ticket.description : "(no description)",
    )
    .replaceAll("{{WORKER_REPO_PATH}}", repoPath)
    .replaceAll("{{FEATURE_BRANCH}}", input.featureBranch)
    .replaceAll("{{FINAL_COMMIT_SHA}}", input.finalCommitSha)
    .replaceAll("{{PR_NUMBER}}", String(input.prNumber))
    .replaceAll("{{ROUND}}", String(input.round))
    .replaceAll("{{DIFF_STAT}}", diffStat)
    .replaceAll("{{TEST_RUN_SUMMARY}}", testSummary)
    .replaceAll("{{CHANGED_PATHS}}", changedPathsBlock);
}

async function loadDefaultPrompt(): Promise<string> {
  const promptUrl = new URL("./prompt.md", import.meta.url);
  return await readFile(fileURLToPath(promptUrl), "utf8");
}

function heartbeat(detail: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(detail);
  } catch {
    // Not running inside an activity context (unit tests).
  }
}
