import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { z } from "zod";
import {
  type CoderPhaseOutput,
  coderPhaseOutputSchema,
} from "../contracts/index.js";
import {
  priorReviewSchema,
  reviewerTicketSchema,
  type PriorReview,
  type ReviewerTicket,
} from "../contracts/reviewer-io.js";
import {
  specPhaseOutputSchema,
  type SpecPhaseOutput,
} from "../contracts/spec-output.js";
import {
  TEMPORAL_WEB_BASE,
  readCoderCorrectionBudget,
  readWorkerRepoPath,
} from "../../temporal/config.js";
import { createLinearClient } from "../../linear/client.js";
import type {
  LinearClientApi,
  SupportedSubTicketType,
} from "../../linear/types.js";
import {
  checkoutFeatureBranch,
  commitAll,
  defaultRunCommand,
  diffPathsTouched,
  hasWorkingTreeChanges,
  pushExistingBranch,
  resolveTestCommand,
  type GitOpsContext,
  type RunCommand,
} from "../shared/repo-ops.js";
import { defaultCoderAgentClient } from "./sdk-client.js";
import type {
  CoderAgentClient,
  CoderAgentDecision,
  CoderAgentSession,
} from "./agent.js";
import type {
  ReportDepMissingArgs,
  ReportDesignQuestionArgs,
} from "./tools.js";

// Heartbeat cadence inside the SDK conversation. The proxy's heartbeatTimeout
// is 30s; 5s leaves comfortable headroom while keeping cost low.
const HEARTBEAT_INTERVAL_MS = 5_000;

// Maximum tail of test runner output we send back to the agent on a false-pass
// correction. Keeps the corrective message bounded.
const RUNNER_OUTPUT_TAIL_BYTES = 4_000;

export const CODER_FAILURE_TYPES = {
  invalidInput: "InvalidCoderPhaseInput",
  depMissingRequested: "DepMissingRequested",
  designQuestionRequested: "DesignQuestionRequested",
  toolBudgetExhausted: "CoderAgentBudgetExhausted",
  pushFailed: "CoderPushFailed",
} as const;

export const coderPhaseInputSchema = z.object({
  ticket: reviewerTicketSchema,
  specOutput: specPhaseOutputSchema,
  priorReview: priorReviewSchema.optional(),
});

export type CoderPhaseInput = z.infer<typeof coderPhaseInputSchema>;

export interface SubTicketDetail {
  id: string;
  identifier: string;
  title: string;
}

export interface RunCoderPhaseDeps {
  agentClient?: CoderAgentClient;
  linearClient?: LinearClientApi;
  runCommand?: RunCommand;
  loadPrompt?: () => Promise<string>;
  resolveWorkflowMeta?: () => { workflowId: string; namespace: string; attempt: number };
  resolveRepoPath?: () => string;
  resolveWebBase?: () => string;
  resolveCorrectionBudget?: () => number;
}

interface InternalContext {
  ticket: ReviewerTicket;
  specOutput: SpecPhaseOutput;
  priorReview: PriorReview | undefined;
  repoPath: string;
  workflowId: string;
  namespace: string;
  attempt: number;
  webBase: string;
  prompt: string;
  agentClient: CoderAgentClient;
  linearClient: LinearClientApi;
  run: RunCommand;
  correctionBudget: number;
}

export async function runCoderPhase(
  input: CoderPhaseInput,
  deps: RunCoderPhaseDeps = {},
): Promise<CoderPhaseOutput> {
  const validated = parseInput(input);
  heartbeat({ phase: "coder", ticketId: validated.ticket.id });

  const meta = (deps.resolveWorkflowMeta ?? defaultResolveWorkflowMeta)();
  const repoPath = (deps.resolveRepoPath ?? readWorkerRepoPath)();
  const webBase = (deps.resolveWebBase ?? (() => TEMPORAL_WEB_BASE))();
  const correctionBudget = (deps.resolveCorrectionBudget ?? readCoderCorrectionBudget)();
  const linearClient = deps.linearClient ?? createLinearClient();
  const agentClient = deps.agentClient ?? defaultCoderAgentClient;
  const run = deps.runCommand ?? defaultRunCommand;
  const loadPrompt = deps.loadPrompt ?? loadDefaultPrompt;

  const promptTemplate = await loadPrompt();
  const prompt = renderPrompt(
    promptTemplate,
    validated.ticket,
    validated.specOutput,
    repoPath,
    validated.priorReview,
  );

  const internal: InternalContext = {
    ticket: validated.ticket,
    specOutput: validated.specOutput,
    priorReview: validated.priorReview,
    repoPath,
    workflowId: meta.workflowId,
    namespace: meta.namespace,
    attempt: meta.attempt,
    webBase,
    prompt,
    agentClient,
    linearClient,
    run,
    correctionBudget,
  };

  const ops: GitOpsContext = { repoRoot: repoPath, run };

  heartbeat({ phase: "coder", action: "checkout", branch: validated.specOutput.featureBranch });
  await checkoutFeatureBranch(ops, validated.specOutput.featureBranch);
  const preAgentSha = await getHeadSha(ops);

  return await driveAgentLoop(internal, ops, preAgentSha);
}

function parseInput(input: CoderPhaseInput): CoderPhaseInput {
  const result = coderPhaseInputSchema.safeParse(input);
  if (!result.success) {
    throw ApplicationFailure.nonRetryable(
      `Invalid coder phase input: ${result.error.message}`,
      CODER_FAILURE_TYPES.invalidInput,
    );
  }
  return result.data;
}

async function driveAgentLoop(
  ctx: InternalContext,
  ops: GitOpsContext,
  preAgentSha: string,
): Promise<CoderPhaseOutput> {
  const abort = new AbortController();
  const heartbeatTimer = setInterval(
    () => heartbeat({ phase: "coder", ticketId: ctx.ticket.id }),
    HEARTBEAT_INTERVAL_MS,
  );
  let session: CoderAgentSession | null = null;
  let corrections = 0;
  try {
    session = await ctx.agentClient.startSession({
      systemPrompt: ctx.prompt,
      userPrompt: "Begin. Decide on a tool and call it.",
      cwd: ctx.repoPath,
      signal: abort.signal,
    });

    let decision = await session.next();
    while (true) {
      if (decision.type === "submit_implementation") {
        const handled = await handleSubmitImplementation(
          ctx,
          ops,
          preAgentSha,
          session,
          corrections,
        );
        if (handled.kind === "done") {
          return handled.output;
        }
        corrections = handled.corrections;
        decision = handled.decision;
        continue;
      }
      if (decision.type === "report_dep_missing") {
        await handleStuck(ctx, "dep-missing", decision.input);
        throw new Error("unreachable");
      }
      if (decision.type === "report_design_question") {
        await handleStuck(ctx, "design-question", decision.input);
        throw new Error("unreachable");
      }
      // no_tool_call or malformed_tool_call → corrective nudge
      if (corrections >= ctx.correctionBudget) {
        throw ApplicationFailure.create({
          message: `Coder agent exhausted correction budget (${ctx.correctionBudget}) without producing a valid tool call`,
          type: CODER_FAILURE_TYPES.toolBudgetExhausted,
          nonRetryable: false,
        });
      }
      corrections += 1;
      const nudge =
        decision.type === "malformed_tool_call"
          ? `Your last tool call had invalid arguments (${decision.error}). Re-call submit_implementation, report_dep_missing, or report_design_question with a valid payload.`
          : "You ended your turn without calling a tool. You must call exactly one of submit_implementation, report_dep_missing, or report_design_question to finish.";
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

interface HandleSubmitDoneResult {
  kind: "done";
  output: CoderPhaseOutput;
}

interface HandleSubmitContinueResult {
  kind: "continue";
  decision: CoderAgentDecision;
  corrections: number;
}

async function handleSubmitImplementation(
  ctx: InternalContext,
  ops: GitOpsContext,
  preAgentSha: string,
  session: CoderAgentSession,
  corrections: number,
): Promise<HandleSubmitDoneResult | HandleSubmitContinueResult> {
  // 1. Diff path check: compare basis SHA against the working tree for any
  // spec test paths the agent may have modified. `commitAll` (run later on
  // the success path) handles staging — we don't need to pre-stage here.
  heartbeat({ phase: "coder", action: "diff_check", ticketId: ctx.ticket.id });
  const testPaths = ctx.specOutput.testCommits.map((c) => c.path);
  const touched = await diffPathsTouched(ops, preAgentSha, testPaths);
  if (touched.length > 0) {
    if (corrections >= ctx.correctionBudget) {
      throw ApplicationFailure.create({
        message: `Coder agent exhausted correction budget (${ctx.correctionBudget}); spec test paths were modified: ${touched.join(", ")}`,
        type: CODER_FAILURE_TYPES.toolBudgetExhausted,
        nonRetryable: false,
      });
    }
    const nudge = buildTestFileTouchedNudge(touched);
    const nextDecision = await session.next(nudge);
    return { kind: "continue", decision: nextDecision, corrections: corrections + 1 };
  }

  // 3. Verify tests pass.
  heartbeat({ phase: "coder", action: "test_run", ticketId: ctx.ticket.id });
  const cmd = await resolveTestCommand(ctx.repoPath);
  const startMs = Date.now();
  const testResult = await ctx.run(cmd.command, cmd.args, { cwd: ctx.repoPath });
  const durationMs = Date.now() - startMs;

  if (testResult.exitCode !== 0) {
    if (corrections >= ctx.correctionBudget) {
      throw ApplicationFailure.create({
        message: `Coder agent exhausted correction budget (${ctx.correctionBudget}); tests still failing on submission`,
        type: CODER_FAILURE_TYPES.toolBudgetExhausted,
        nonRetryable: false,
      });
    }
    const nudge = buildTestStillFailingNudge(testResult.stdout, testResult.stderr);
    const nextDecision = await session.next(nudge);
    return { kind: "continue", decision: nextDecision, corrections: corrections + 1 };
  }

  // 4. Empty-diff guard: tests passed but the working tree might be identical
  // to HEAD (e.g. the agent re-submitted on a correction round without making
  // any new edits, or reverted its own changes). `commitAll` would fail with
  // a fatal "nothing to commit" — instead, nudge the agent so it actually
  // addresses the upstream feedback.
  heartbeat({ phase: "coder", action: "diff_check", ticketId: ctx.ticket.id });
  const hasChanges = await hasWorkingTreeChanges(ops);
  if (!hasChanges) {
    if (corrections >= ctx.correctionBudget) {
      throw ApplicationFailure.create({
        message: `Coder agent exhausted correction budget (${ctx.correctionBudget}); submitted with no working-tree changes`,
        type: CODER_FAILURE_TYPES.toolBudgetExhausted,
        nonRetryable: false,
      });
    }
    const nudge = buildEmptyDiffNudge(ctx.priorReview);
    const nextDecision = await session.next(nudge);
    return { kind: "continue", decision: nextDecision, corrections: corrections + 1 };
  }

  // 5. Commit and push.
  heartbeat({ phase: "coder", action: "commit", ticketId: ctx.ticket.id });
  const subject = `feat(coder): make spec tests green for ${ctx.ticket.identifier}`;
  const finalCommitSha = await commitAll(ops, {
    subject,
    trailer: {
      workflowId: ctx.workflowId,
      ticketId: ctx.ticket.id,
      attempt: ctx.attempt,
    },
    phase: "coder",
  });

  heartbeat({ phase: "coder", action: "push", branch: ctx.specOutput.featureBranch });
  try {
    await pushExistingBranch(ops, ctx.specOutput.featureBranch);
  } catch (error) {
    throw ApplicationFailure.create({
      message: `git push origin ${ctx.specOutput.featureBranch} failed: ${error instanceof Error ? error.message : String(error)}`,
      type: CODER_FAILURE_TYPES.pushFailed,
      nonRetryable: false,
      cause: error instanceof Error ? error : undefined,
    });
  }

  // 5. Build CoderPhaseOutput.
  const diffStat = await readDiffStat(ops, preAgentSha);
  const testRunSummary = parseTestRunSummary(testResult.stdout, testResult.stderr, durationMs);

  const output = {
    featureBranch: ctx.specOutput.featureBranch,
    finalCommitSha,
    diffStat,
    testRunSummary,
  };
  return { kind: "done", output: coderPhaseOutputSchema.parse(output) };
}

async function handleStuck(
  ctx: InternalContext,
  type: Extract<SupportedSubTicketType, "dep-missing" | "design-question">,
  input: ReportDepMissingArgs | ReportDesignQuestionArgs,
): Promise<never> {
  heartbeat({ phase: "coder", action: type, ticketId: ctx.ticket.id });
  const body = buildStuckBody({
    reason: input.reason,
    dependency: "dependency" in input ? input.dependency : undefined,
    questions: input.questions,
  });
  const deepLink = buildWorkflowDeepLink(ctx.webBase, ctx.namespace, ctx.workflowId);

  let subTicket: SubTicketDetail;
  try {
    subTicket = await ctx.linearClient.createSubTicket(ctx.ticket.id, type, body, deepLink);
  } catch (error) {
    throw ApplicationFailure.create({
      message: `Linear sub-ticket creation failed: ${error instanceof Error ? error.message : String(error)}`,
      type: "LinearSubTicketCreationFailed",
      nonRetryable: false,
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (type === "dep-missing") {
    throw ApplicationFailure.nonRetryable(
      `Coder agent reported missing dependency: opened ${subTicket.identifier}`,
      CODER_FAILURE_TYPES.depMissingRequested,
      { subTicketRef: subTicket },
    );
  }
  throw ApplicationFailure.nonRetryable(
    `Coder agent reported design question: opened ${subTicket.identifier}`,
    CODER_FAILURE_TYPES.designQuestionRequested,
    { subTicketRef: subTicket },
  );
}

export interface BuildStuckBodyInput {
  reason: string;
  dependency?: string;
  questions: ReadonlyArray<string>;
}

export function buildStuckBody(input: BuildStuckBodyInput): string {
  const reason = input.reason.trim();
  const checklist = input.questions.map((q) => `- [ ] ${q.trim()}`).join("\n");
  const dependencyLine = input.dependency
    ? `\n\n**Missing dependency:** ${input.dependency.trim()}`
    : "";
  return `## Why this is blocked\n\n${reason}${dependencyLine}\n\n## Questions to resolve\n\n${checklist}\n`;
}

export function buildWorkflowDeepLink(
  webBase: string,
  namespace: string,
  workflowId: string,
): string {
  const trimmed = webBase.replace(/\/$/, "");
  return `${trimmed}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

function buildTestFileTouchedNudge(paths: ReadonlyArray<string>): string {
  const list = paths.map((p) => `- ${p}`).join("\n");
  return [
    "Your submission modified one or more spec test files. Revert those changes and edit only production code.",
    "Modified test paths:",
    list,
  ].join("\n\n");
}

function buildEmptyDiffNudge(priorReview: PriorReview | undefined): string {
  const base =
    "You called submit_implementation but the working tree is identical to HEAD — no files were actually changed. Tests pass only because the prior commit already made them green.";
  if (!priorReview) {
    return [
      base,
      "Apply the edits required to address this round's intent, then call submit_implementation again. If you believe no code change is needed, call report_design_question to escalate.",
    ].join("\n\n");
  }
  const blockers = priorReview.findings
    .filter((f) => f.severity === "blocking")
    .map((f) => {
      const loc = f.line !== undefined ? `${f.path}:${f.line}` : f.path;
      return `- ${loc} — ${f.message}`;
    });
  const blockerBlock =
    blockers.length > 0
      ? `Blocking findings from PR #${priorReview.prNumber} that still need addressing:\n${blockers.join("\n")}`
      : `Reviewer summary from PR #${priorReview.prNumber}: ${priorReview.reviewSummary}`;
  return [
    base,
    "This phase exists because the previous review requested changes — apply edits that address the feedback, then call submit_implementation again.",
    blockerBlock,
    "If you genuinely believe no code change is required (e.g. the reviewer is wrong about a fact you can verify in the diff), call report_design_question instead.",
  ].join("\n\n");
}

function buildTestStillFailingNudge(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  const tail =
    combined.length > RUNNER_OUTPUT_TAIL_BYTES
      ? `${combined.slice(-RUNNER_OUTPUT_TAIL_BYTES)}\n…(truncated)`
      : combined;
  return [
    "The repo's test command still exits non-zero. Continue iterating on production code only.",
    "Test runner output (tail):",
    tail,
  ].join("\n\n");
}

async function getHeadSha(ops: GitOpsContext): Promise<string> {
  const result = await ops.run("git", ["rev-parse", "HEAD"], { cwd: ops.repoRoot });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

async function readDiffStat(
  ops: GitOpsContext,
  basisRef: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const result = await ops.run("git", ["diff", "--shortstat", basisRef, "HEAD"], {
    cwd: ops.repoRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff --shortstat ${basisRef} HEAD failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return parseShortStat(result.stdout);
}

// `git diff --shortstat` output examples:
//   " 2 files changed, 10 insertions(+), 1 deletion(-)"
//   " 1 file changed, 5 insertions(+)"
//   ""  (no changes)
export function parseShortStat(line: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(line);
  const insMatch = /(\d+)\s+insertions?\(\+\)/.exec(line);
  const delMatch = /(\d+)\s+deletions?\(-\)/.exec(line);
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: insMatch ? Number(insMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  };
}

// Best-effort parse of common Node test runner output (vitest, jest). Falls
// back to total=passed=1 if no recognizable summary line is found, since the
// activity already verified exit code 0.
export function parseTestRunSummary(
  stdout: string,
  stderr: string,
  durationMs: number,
): { total: number; passed: number; failed: number; durationMs: number } {
  const combined = `${stdout}\n${stderr}`;

  // Vitest: "Tests  N passed (N)" or "Tests  N passed | M failed (T)"
  const vitest = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed[^(]*\((\d+)\)/i.exec(combined);
  if (vitest) {
    const failed = vitest[1] ? Number(vitest[1]) : 0;
    const passed = Number(vitest[2]);
    const total = Number(vitest[3]);
    return clampSummary({ total, passed, failed, durationMs });
  }

  // Jest: "Tests:       N passed, M total" or "Tests: N failed, M passed, T total"
  const jest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/i.exec(combined);
  if (jest) {
    const failed = jest[1] ? Number(jest[1]) : 0;
    const passed = Number(jest[2]);
    const total = Number(jest[3]);
    return clampSummary({ total, passed, failed, durationMs });
  }

  return { total: 1, passed: 1, failed: 0, durationMs };
}

function clampSummary(input: {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
}): { total: number; passed: number; failed: number; durationMs: number } {
  const total = Math.max(input.total, input.passed + input.failed);
  return {
    total,
    passed: Math.max(0, input.passed),
    failed: Math.max(0, input.failed),
    durationMs: Math.max(0, input.durationMs),
  };
}

export function renderPrompt(
  template: string,
  ticket: ReviewerTicket,
  specOutput: SpecPhaseOutput,
  repoPath: string,
  priorReview?: PriorReview,
): string {
  const testList = specOutput.testCommits.map((c) => `- \`${c.path}\``).join("\n");
  return template
    .replaceAll("{{TICKET_IDENTIFIER}}", ticket.identifier)
    .replaceAll("{{TICKET_TITLE}}", ticket.title)
    .replaceAll(
      "{{TICKET_DESCRIPTION}}",
      ticket.description.length > 0 ? ticket.description : "(no description)",
    )
    .replaceAll("{{WORKER_REPO_PATH}}", repoPath)
    .replaceAll("{{FEATURE_BRANCH}}", specOutput.featureBranch)
    .replaceAll("{{TEST_FILES}}", testList)
    .replaceAll("{{PRIOR_REVIEW_SECTION}}", renderPriorReviewSection(priorReview));
}

function renderPriorReviewSection(priorReview: PriorReview | undefined): string {
  if (!priorReview) {
    return "";
  }
  const findingLines = priorReview.findings.map((f) => {
    const loc = f.line !== undefined ? `${f.path}:${f.line}` : f.path;
    return `- [${f.severity}] ${loc} — ${f.message}`;
  });
  const findingsBlock = findingLines.length > 0 ? findingLines.join("\n") : "(no findings)";
  return [
    "",
    "## Prior reviewer feedback",
    "",
    `A previous review of PR #${priorReview.prNumber} requested changes. Address every blocking finding while keeping the spec tests green; advisory findings are suggestions you may decline.`,
    "",
    "### Reviewer summary",
    "",
    priorReview.reviewSummary,
    "",
    "### Findings",
    "",
    findingsBlock,
    "",
  ].join("\n");
}

async function loadDefaultPrompt(): Promise<string> {
  const promptUrl = new URL("./prompt.md", import.meta.url);
  return await readFile(fileURLToPath(promptUrl), "utf8");
}

function defaultResolveWorkflowMeta(): { workflowId: string; namespace: string; attempt: number } {
  try {
    const info = Context.current().info;
    return {
      workflowId: info.workflowExecution.workflowId,
      namespace: info.workflowNamespace,
      attempt: info.attempt,
    };
  } catch {
    return { workflowId: "<unknown>", namespace: "default", attempt: 1 };
  }
}

function heartbeat(detail: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(detail);
  } catch {
    // Not running inside an activity context (unit tests).
  }
}
