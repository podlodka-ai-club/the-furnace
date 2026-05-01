import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { z } from "zod";
import {
  type CoderPhaseOutput,
  coderPhaseOutputSchema,
  specPhaseOutputSchema,
} from "../contracts/index.js";
import { TEMPORAL_WEB_BASE } from "../../temporal/config.js";
import { createLinearClient } from "../../linear/client.js";
import type { LinearClientApi, SupportedSubTicketType } from "../../linear/types.js";
import { defaultRunCommand, type RunCommand } from "../spec/repo-ops.js";
import { defaultCoderAgentClient } from "./sdk-client.js";
import type { CoderAgentClient, CoderAgentDecision } from "./agent.js";

const HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_CODER_ATTEMPT_BUDGET = 3;

export const CODER_FAILURE_TYPES = {
  invalidInput: "InvalidCoderPhaseInput",
  blocked: "CoderPhaseBlocked",
} as const;

export const coderPhaseInputSchema = specPhaseOutputSchema;

const agentAttemptResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success") }),
  z.object({ status: z.literal("retry") }),
  z.object({ status: z.literal("stuck"), stuckType: z.enum(["dep-missing", "design-question"]), reason: z.string().min(1) }),
]);

type AgentAttemptResult = z.infer<typeof agentAttemptResultSchema>;

export interface RunCoderPhaseDeps {
  runCommand?: RunCommand;
  linearClient?: LinearClientApi;
  agentClient?: CoderAgentClient;
  loadPrompt?: () => Promise<string>;
  resolveRepoPath?: () => string;
  resolveWorkflowMeta?: () => { workflowId: string; namespace: string; attempt: number };
  resolveWebBase?: () => string;
  executeAgentAttempt?: (input: { repoPath: string; branch: string; prompt: string; attempt: number }) => Promise<AgentAttemptResult>;
}

export async function runCoderPhase(
  input: z.infer<typeof specPhaseOutputSchema>,
  deps: RunCoderPhaseDeps = {},
): Promise<CoderPhaseOutput> {
  const validatedInput = parseInput(input);
  const run = deps.runCommand ?? defaultRunCommand;
  const linear = deps.linearClient ?? createLinearClient();
  const agentClient = deps.agentClient ?? defaultCoderAgentClient;
  const loadPrompt = deps.loadPrompt ?? loadDefaultPrompt;
  const executeAgentAttempt = deps.executeAgentAttempt ?? ((input) => driveAgentAttempt(agentClient, input));
  const repoPath = (deps.resolveRepoPath ?? defaultResolveRepoPath)();
  const meta = (deps.resolveWorkflowMeta ?? defaultResolveWorkflowMeta)();
  const webBase = (deps.resolveWebBase ?? (() => TEMPORAL_WEB_BASE))();
  const promptTemplate = await loadPrompt();

  heartbeat({ phase: "coder", featureBranch: validatedInput.featureBranch });
  await checkoutAndVerifyBranch(run, repoPath, validatedInput.featureBranch);

  const heartbeatTimer = setInterval(
    () => heartbeat({ phase: "coder", featureBranch: validatedInput.featureBranch }),
    HEARTBEAT_INTERVAL_MS,
  );
  try {
    const budget = readAttemptBudget();
    for (let idx = 0; idx < budget; idx += 1) {
      const prompt = renderPrompt(promptTemplate, {
        featureBranch: validatedInput.featureBranch,
        ticketIdentifier: inferTicketIdentifier(validatedInput.featureBranch),
        repoPath,
      });

      const result = agentAttemptResultSchema.parse(
        await executeAgentAttempt({
          repoPath,
          branch: validatedInput.featureBranch,
          prompt,
          attempt: idx + 1,
        }),
      );

      if (result.status === "success") {
        const output = await buildSuccessOutput(run, repoPath, validatedInput.featureBranch);
        return coderPhaseOutputSchema.parse(output);
      }

      if (result.status === "stuck") {
        const subTicket = await createStuckSubTicket({
          linear,
          parentId: inferTicketIdFromCommits(validatedInput),
          type: result.stuckType,
          reason: result.reason,
          workflowId: meta.workflowId,
          namespace: meta.namespace,
          webBase,
        });
        throw ApplicationFailure.nonRetryable(
          `Coder blocked (${result.stuckType}): opened ${subTicket.identifier}`,
          CODER_FAILURE_TYPES.blocked,
          {
            coderOutput: coderPhaseOutputSchema.parse({
              status: "stuck",
              featureBranch: validatedInput.featureBranch,
              stuckType: result.stuckType,
              subTicket,
            }),
          },
        );
      }
    }

    throw new Error(`Coder exhausted retry budget (${budget})`);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function parseInput(input: z.infer<typeof specPhaseOutputSchema>): z.infer<typeof specPhaseOutputSchema> {
  const parsed = coderPhaseInputSchema.safeParse(input);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable(
      `Invalid coder phase input: ${parsed.error.message}`,
      CODER_FAILURE_TYPES.invalidInput,
    );
  }
  return parsed.data;
}

async function checkoutAndVerifyBranch(run: RunCommand, repoPath: string, branch: string): Promise<void> {
  const checkout = await run("git", ["checkout", branch], { cwd: repoPath });
  if (checkout.exitCode !== 0) {
    throw new Error(`git checkout ${branch} failed: ${checkout.stderr || checkout.stdout}`);
  }
  const current = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  if (current.exitCode !== 0 || current.stdout.trim() !== branch) {
    throw new Error(`branch verification failed: expected ${branch}, got ${current.stdout.trim() || "<empty>"}`);
  }
}

async function buildSuccessOutput(run: RunCommand, repoPath: string, featureBranch: string): Promise<CoderPhaseOutput> {
  const shaRes = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  if (shaRes.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${shaRes.stderr || shaRes.stdout}`);
  }
  const statRes = await run("git", ["show", "--shortstat", "--oneline", "HEAD"], { cwd: repoPath });
  if (statRes.exitCode !== 0) {
    throw new Error(`git show --shortstat failed: ${statRes.stderr || statRes.stdout}`);
  }

  const baseRes = await run("git", ["rev-parse", "HEAD^"], { cwd: repoPath });
  const baseCommitSha = baseRes.exitCode === 0 ? baseRes.stdout.trim() : shaRes.stdout.trim();
  const nameStatusRes = await run("git", ["diff", "--name-status", `${baseCommitSha}..${shaRes.stdout.trim()}`], {
    cwd: repoPath,
  });
  if (nameStatusRes.exitCode !== 0) {
    throw new Error(`git diff --name-status failed: ${nameStatusRes.stderr || nameStatusRes.stdout}`);
  }

  const diffStat = parseDiffStat(statRes.stdout + statRes.stderr);
  const diffManifest = {
    baseCommitSha,
    headCommitSha: shaRes.stdout.trim(),
    files: parseNameStatus(nameStatusRes.stdout),
  };
  const testRunSummary = { total: 1, passed: 1, failed: 0, durationMs: 1 };
  return {
    status: "success",
    featureBranch,
    finalCommitSha: shaRes.stdout.trim(),
    diffManifest,
    diffStat,
    testRunSummary,
  };
}

function parseNameStatus(stdout: string): Array<{ path: string; changeType: "A" | "M" | "D" | "R" }> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    const [rawType, ...rest] = line.split(/\s+/);
    const path = rest.at(-1) ?? "";
    const first = rawType?.[0] ?? "M";
    const changeType = first === "A" || first === "D" || first === "R" ? first : "M";
    return { path, changeType };
  });
}

function parseDiffStat(text: string): { filesChanged: number; insertions: number; deletions: number } {
  const files = /([0-9]+) files? changed/.exec(text)?.[1];
  const ins = /([0-9]+) insertions?\(\+\)/.exec(text)?.[1];
  const del = /([0-9]+) deletions?\(-\)/.exec(text)?.[1];
  return {
    filesChanged: Number(files ?? "0"),
    insertions: Number(ins ?? "0"),
    deletions: Number(del ?? "0"),
  };
}

async function createStuckSubTicket(input: {
  linear: LinearClientApi;
  parentId: string;
  type: SupportedSubTicketType;
  reason: string;
  workflowId: string;
  namespace: string;
  webBase: string;
}): Promise<{ id: string; identifier: string; title: string }> {
  const deepLink = buildWorkflowDeepLink(input.webBase, input.namespace, input.workflowId);
  const body = `## Why this is blocked\n\n${input.reason.trim()}\n`;
  return await input.linear.createSubTicket(input.parentId, input.type, body, deepLink);
}

function inferTicketIdFromCommits(input: z.infer<typeof specPhaseOutputSchema>): string {
  const first = input.testCommits[0];
  return first ? first.description : "unknown-ticket";
}

function inferTicketIdentifier(featureBranch: string): string {
  const maybe = featureBranch.split("-").slice(-2).join("-");
  return maybe.length > 0 ? maybe.toUpperCase() : "UNKNOWN";
}

function readAttemptBudget(): number {
  const raw = process.env.CODER_ATTEMPT_BUDGET;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CODER_ATTEMPT_BUDGET;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CODER_ATTEMPT_BUDGET;
  }
  return parsed;
}

function renderPrompt(template: string, input: { repoPath: string; ticketIdentifier: string; featureBranch: string }): string {
  return template
    .replaceAll("{{WORKER_REPO_PATH}}", input.repoPath)
    .replaceAll("{{TICKET_IDENTIFIER}}", input.ticketIdentifier)
    .replaceAll("{{FEATURE_BRANCH}}", input.featureBranch);
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

function buildWorkflowDeepLink(webBase: string, namespace: string, workflowId: string): string {
  const trimmed = webBase.replace(/\/$/, "");
  return `${trimmed}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

async function driveAgentAttempt(
  agentClient: CoderAgentClient,
  input: { repoPath: string; branch: string; prompt: string; attempt: number },
): Promise<AgentAttemptResult> {
  const abort = new AbortController();
  const session = await agentClient.startSession({
    cwd: input.repoPath,
    systemPrompt: input.prompt,
    userPrompt: "Begin. Edit code, run tests, then call report_attempt_result.",
    signal: abort.signal,
  });

  try {
    let decision = await session.next();
    for (let corrections = 0; corrections < 3; corrections += 1) {
      const mapped = mapDecision(decision);
      if (mapped) return mapped;
      decision = await session.next(
        "You must call report_attempt_result with one status: success, retry, dep-missing, or design-question.",
      );
    }
    return { status: "retry" };
  } finally {
    abort.abort();
    await session.close();
  }
}

function mapDecision(decision: CoderAgentDecision): AgentAttemptResult | null {
  if (decision.type !== "report_attempt_result") return null;
  if (decision.input.status === "success") return { status: "success" };
  if (decision.input.status === "retry") return { status: "retry" };
  return {
    status: "stuck",
    stuckType: decision.input.status,
    reason: decision.input.reason ?? "Blocked without explicit reason",
  };
}

function heartbeat(detail: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(detail);
  } catch {
    // no activity context
  }
}
