import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  type SpecPhaseOutput,
  specPhaseOutputSchema,
} from "../contracts/index.js";
import {
  reviewerTicketSchema,
  type ReviewerTicket,
} from "../contracts/reviewer-io.js";
import { z } from "zod";
import { TEMPORAL_WEB_BASE } from "../../temporal/config.js";
import { createLinearClient } from "../../linear/client.js";
import type { LinearClientApi } from "../../linear/types.js";
import {
  buildCommitMessage,
  classifyTestRun,
  commitFile,
  createFeatureBranch,
  defaultRunCommand,
  getDefaultBranch,
  pushBranch,
  resolveTestCommand,
  type GitOpsContext,
  type ProposedFile,
  type RunCommand,
} from "./repo-ops.js";
import { writeProposedFile } from "./repo-ops.js";
import {
  defaultSpecAgentClient,
} from "./sdk-client.js";
import type {
  SpecAgentClient,
  SpecAgentDecision,
  SpecAgentSession,
} from "./agent.js";

void buildCommitMessage; // Re-exported indirectly via repo-ops; avoid unused import.

// Maximum corrective messages we send per SDK conversation (prose-only or
// false-failing-test cases combined). Beyond this we surface a retryable
// error so Temporal launches a fresh container.
export const SPEC_CORRECTION_BUDGET = 3;

// Heartbeat cadence inside the SDK conversation. The proxy's heartbeatTimeout
// is 30s; 5s leaves comfortable headroom while keeping cost low.
const HEARTBEAT_INTERVAL_MS = 5_000;

// Failure types surfaced to the workflow as ApplicationFailure.type values.
export const SPEC_FAILURE_TYPES = {
  invalidInput: "InvalidSpecPhaseInput",
  acClarificationRequested: "AcClarificationRequested",
  toolBudgetExhausted: "SpecAgentBudgetExhausted",
  testVerificationFailed: "SpecTestVerificationFailed",
} as const;

export const specPhaseInputSchema = z.object({
  ticket: reviewerTicketSchema,
});

export interface SpecPhaseInput {
  ticket: ReviewerTicket;
}

export interface TicketRecord {
  id: string;
  identifier: string;
  title: string;
  description: string;
}

export interface RunSpecPhaseDeps {
  agentClient?: SpecAgentClient;
  linearClient?: LinearClientApi;
  runCommand?: RunCommand;
  loadPrompt?: () => Promise<string>;
  // Workflow id and namespace overrides (used by tests; default to Temporal Context).
  resolveWorkflowMeta?: () => { workflowId: string; namespace: string; attempt: number };
  // Override the repo path inside the container; default reads WORKER_REPO_PATH.
  resolveRepoPath?: () => string;
  // Override TEMPORAL_WEB_BASE source; default reads the imported config.
  resolveWebBase?: () => string;
}

export interface SubTicketDetail {
  id: string;
  identifier: string;
  title: string;
}

interface InternalContext {
  ticket: TicketRecord;
  repoPath: string;
  workflowId: string;
  namespace: string;
  attempt: number;
  webBase: string;
  prompt: string;
  agentClient: SpecAgentClient;
  linearClient: LinearClientApi;
  run: RunCommand;
}

export async function runSpecPhase(
  input: SpecPhaseInput,
  deps: RunSpecPhaseDeps = {},
): Promise<SpecPhaseOutput> {
  const validatedInput = parseInput(input);
  heartbeat({ phase: "spec", ticketId: validatedInput.ticket.id });

  const meta = (deps.resolveWorkflowMeta ?? defaultResolveWorkflowMeta)();
  const repoPath = (deps.resolveRepoPath ?? defaultResolveRepoPath)();
  const webBase = (deps.resolveWebBase ?? (() => TEMPORAL_WEB_BASE))();
  const linearClient = deps.linearClient ?? createLinearClient();
  const agentClient = deps.agentClient ?? defaultSpecAgentClient;
  const run = deps.runCommand ?? defaultRunCommand;
  const loadPrompt = deps.loadPrompt ?? loadDefaultPrompt;

  const ticket: TicketRecord = {
    id: validatedInput.ticket.id,
    identifier: validatedInput.ticket.identifier,
    title: validatedInput.ticket.title,
    description: validatedInput.ticket.description,
  };

  const promptTemplate = await loadPrompt();
  const prompt = renderPrompt(promptTemplate, ticket, repoPath);

  const internal: InternalContext = {
    ticket,
    repoPath,
    workflowId: meta.workflowId,
    namespace: meta.namespace,
    attempt: meta.attempt,
    webBase,
    prompt,
    agentClient,
    linearClient,
    run,
  };

  return await driveAgentLoop(internal);
}

function parseInput(input: SpecPhaseInput): SpecPhaseInput {
  const result = specPhaseInputSchema.safeParse(input);
  if (!result.success) {
    throw ApplicationFailure.nonRetryable(
      `Invalid spec phase input: ${result.error.message}`,
      SPEC_FAILURE_TYPES.invalidInput,
    );
  }
  return result.data;
}

async function driveAgentLoop(ctx: InternalContext): Promise<SpecPhaseOutput> {
  const abort = new AbortController();
  const heartbeatTimer = setInterval(() => heartbeat({ phase: "spec", ticketId: ctx.ticket.id }), HEARTBEAT_INTERVAL_MS);
  // Build system prompt from the rendered prompt; the tool descriptions and
  // ticket body live entirely in `prompt`. The first user message is a
  // minimal nudge — the system prompt already contains the work.
  let session: SpecAgentSession | null = null;
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
      if (decision.type === "propose_failing_tests") {
        const handled = await handleProposeFailingTests(ctx, decision.input.files, session, corrections);
        if (handled.kind === "done") {
          return handled.output;
        }
        // false-failing-test correction: continue the loop with new decision
        corrections = handled.corrections;
        decision = handled.decision;
        continue;
      }
      if (decision.type === "request_ac_clarification") {
        await handleRequestAcClarification(ctx, decision.input);
        // handleRequestAcClarification always throws on success path
        throw new Error("unreachable");
      }
      // no_tool_call or malformed_tool_call → corrective nudge
      if (corrections >= SPEC_CORRECTION_BUDGET) {
        throw ApplicationFailure.create({
          message: `Spec agent exhausted correction budget (${SPEC_CORRECTION_BUDGET}) without producing a valid tool call`,
          type: SPEC_FAILURE_TYPES.toolBudgetExhausted,
          nonRetryable: false,
        });
      }
      corrections += 1;
      const nudge = decision.type === "malformed_tool_call"
        ? `Your last tool call had invalid arguments (${decision.error}). Re-call propose_failing_tests or request_ac_clarification with a valid payload.`
        : "You ended your turn without calling a tool. You must call exactly one of propose_failing_tests or request_ac_clarification to finish.";
      decision = await session.next(nudge);
    }
  } finally {
    clearInterval(heartbeatTimer);
    abort.abort();
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

interface HandleProposeDoneResult {
  kind: "done";
  output: SpecPhaseOutput;
}

interface HandleProposeContinueResult {
  kind: "continue";
  decision: SpecAgentDecision;
  corrections: number;
}

async function handleProposeFailingTests(
  ctx: InternalContext,
  files: ProposedFile[],
  session: SpecAgentSession,
  corrections: number,
): Promise<HandleProposeDoneResult | HandleProposeContinueResult> {
  // 1. Write each proposed file under the repo root.
  const writtenPaths: string[] = [];
  for (const file of files) {
    await writeProposedFile(ctx.repoPath, file);
    writtenPaths.push(file.path);
  }

  // 2. Resolve and run the test command.
  const cmd = await resolveTestCommand(ctx.repoPath);
  heartbeat({ phase: "spec", action: "test_run", ticketId: ctx.ticket.id });
  const result = await ctx.run(cmd.command, cmd.args, { cwd: ctx.repoPath });
  const verdict = classifyTestRun(result, writtenPaths);

  if (!verdict.anyProposedFailed) {
    // No failures observed — agent's tests passed on the unchanged baseline.
    if (corrections >= SPEC_CORRECTION_BUDGET) {
      throw ApplicationFailure.create({
        message: `Spec agent exhausted correction budget (${SPEC_CORRECTION_BUDGET}); proposed tests still pass on default branch`,
        type: SPEC_FAILURE_TYPES.toolBudgetExhausted,
        nonRetryable: false,
      });
    }
    const nudge = buildFalseFailingNudge(verdict.passingProposedPaths, verdict.combinedOutput);
    const nextDecision = await session.next(nudge);
    return { kind: "continue", decision: nextDecision, corrections: corrections + 1 };
  }

  // 3. Branch from default and commit each file as its own commit.
  const ops: GitOpsContext = { repoRoot: ctx.repoPath, run: ctx.run };
  const defaultBranch = await getDefaultBranch(ops);
  const featureBranch = `agent/spec-${ctx.ticket.identifier.toLowerCase()}`;
  await createFeatureBranch(ops, featureBranch, defaultBranch);

  const commits: SpecPhaseOutput["testCommits"] = [];
  for (const file of files) {
    heartbeat({ phase: "spec", action: "commit", path: file.path });
    const sha = await commitFile(ops, file, {
      workflowId: ctx.workflowId,
      ticketId: ctx.ticket.id,
      attempt: ctx.attempt,
    });
    commits.push({ sha, path: file.path, description: file.description });
  }

  // 4. Push to origin.
  heartbeat({ phase: "spec", action: "push", branch: featureBranch });
  await pushBranch(ops, featureBranch);

  const output = { featureBranch, testCommits: commits };
  // 5. Defense-in-depth: validate before returning so a malformed payload
  // throws rather than reaches the workflow.
  return { kind: "done", output: specPhaseOutputSchema.parse(output) };
}

function buildFalseFailingNudge(passingPaths: ReadonlyArray<string>, output: string): string {
  const passingList = passingPaths.length > 0
    ? passingPaths.map((p) => `- ${p}`).join("\n")
    : "(could not isolate which files passed; the suite as a whole did not fail)";
  const truncated = output.length > 4000 ? `${output.slice(-4000)}\n…(truncated)` : output;
  return [
    "Your proposed tests did not fail on the default branch. Replace them so that at least one new test fails before any production code is written.",
    "Tests that passed:",
    passingList,
    "Test runner output (tail):",
    truncated,
  ].join("\n\n");
}

async function handleRequestAcClarification(
  ctx: InternalContext,
  input: { reason: string; questions: string[] },
): Promise<never> {
  heartbeat({ phase: "spec", action: "request_clarification", ticketId: ctx.ticket.id });
  const body = buildClarificationBody(input);
  const deepLink = buildWorkflowDeepLink(ctx.webBase, ctx.namespace, ctx.workflowId);

  let subTicket: SubTicketDetail;
  try {
    subTicket = await ctx.linearClient.createSubTicket(
      ctx.ticket.id,
      "ac-clarification",
      body,
      deepLink,
    );
  } catch (error) {
    // Linear outage: surface as retryable so Temporal retries the activity.
    throw ApplicationFailure.create({
      message: `Linear sub-ticket creation failed: ${error instanceof Error ? error.message : String(error)}`,
      type: "LinearSubTicketCreationFailed",
      nonRetryable: false,
      cause: error instanceof Error ? error : undefined,
    });
  }

  throw ApplicationFailure.nonRetryable(
    `Spec agent requested AC clarification: opened ${subTicket.identifier}`,
    SPEC_FAILURE_TYPES.acClarificationRequested,
    { subTicketRef: subTicket },
  );
}

export function buildClarificationBody(input: { reason: string; questions: string[] }): string {
  const reason = input.reason.trim();
  const checklist = input.questions.map((q) => `- [ ] ${q.trim()}`).join("\n");
  return `## Why this is blocked\n\n${reason}\n\n## Questions to resolve\n\n${checklist}\n`;
}

export function buildWorkflowDeepLink(
  webBase: string,
  namespace: string,
  workflowId: string,
): string {
  const trimmed = webBase.replace(/\/$/, "");
  return `${trimmed}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

export function renderPrompt(template: string, ticket: TicketRecord, repoPath: string): string {
  return template
    .replaceAll("{{TICKET_IDENTIFIER}}", ticket.identifier)
    .replaceAll("{{TICKET_TITLE}}", ticket.title)
    .replaceAll("{{TICKET_DESCRIPTION}}", ticket.description.length > 0 ? ticket.description : "(no description)")
    .replaceAll("{{WORKER_REPO_PATH}}", repoPath);
}

async function loadDefaultPrompt(): Promise<string> {
  const promptUrl = new URL("./prompt.md", import.meta.url);
  return await readFile(fileURLToPath(promptUrl), "utf8");
}

function defaultResolveRepoPath(): string {
  return process.env.WORKER_REPO_PATH ?? "/workspace";
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
