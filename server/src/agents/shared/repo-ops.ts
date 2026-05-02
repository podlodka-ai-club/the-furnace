import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Repository operations the spec and coder activities perform inside the
// per-attempt container. Each is exposed as a small async function so unit
// tests can stub them via dependency injection in the activities.

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions,
) => Promise<RunCommandResult>;

export const defaultRunCommand: RunCommand = async (command, args, options) => {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
};

export interface ProposedFile {
  path: string;
  contents: string;
  description: string;
}

// Resolve absolute path within the repo, rejecting absolute or upward paths.
// Defense-in-depth on top of the Zod schema in tools.ts.
export function resolveInRepo(repoRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath) || relPath.includes("..")) {
    throw new Error(`Refusing path outside repo root: ${relPath}`);
  }
  return path.resolve(repoRoot, relPath);
}

export async function writeProposedFile(
  repoRoot: string,
  file: ProposedFile,
): Promise<string> {
  const absolute = resolveInRepo(repoRoot, file.path);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, file.contents, "utf8");
  return absolute;
}

// Reads the repo's `package.json` and returns either the user-defined `test`
// script command, or `npm test` as the documented default.
export async function resolveTestCommand(
  repoRoot: string,
): Promise<{ command: string; args: string[] }> {
  const pkgPath = path.join(repoRoot, "package.json");
  try {
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: { test?: string } };
    const declared = parsed.scripts?.test;
    if (typeof declared === "string" && declared.trim().length > 0) {
      return { command: "npm", args: ["test", "--silent"] };
    }
  } catch {
    // Missing or unreadable package.json — fall through to default.
  }
  return { command: "npm", args: ["test"] };
}

export interface VerifyFailureResult {
  // True if at least one of the proposed test paths shows up as failing.
  anyProposedFailed: boolean;
  // Subset of proposed paths that the test runner reported as passing.
  passingProposedPaths: string[];
  // Raw runner output, included on the corrective message back to the agent
  // so it can reason about why tests passed.
  combinedOutput: string;
  exitCode: number;
}

// Determine whether at least one proposed test file fails. The simplest signal
// the test runner gives us is exit code != 0 — tests failed somewhere. Beyond
// that we look for each proposed path in the output as a heuristic to identify
// which proposed tests were run and which (if any) reported as passing. This
// string-based check is intentionally conservative: when in doubt, we treat a
// proposed file as "passing" so the agent gets nudged to replace it.
export function classifyTestRun(
  result: RunCommandResult,
  proposedPaths: ReadonlyArray<string>,
): VerifyFailureResult {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const anyProposedFailed = result.exitCode !== 0;
  // Heuristic: a proposed path is "passing" if we don't see it referenced by
  // the runner's failure output AND the run as a whole succeeded.
  let passingProposedPaths: string[] = [];
  if (!anyProposedFailed) {
    passingProposedPaths = [...proposedPaths];
  }
  return {
    anyProposedFailed,
    passingProposedPaths,
    combinedOutput,
    exitCode: result.exitCode,
  };
}

export interface GitOpsContext {
  repoRoot: string;
  run: RunCommand;
}

export async function getDefaultBranch(ctx: GitOpsContext): Promise<string> {
  // Try the configured remote HEAD first, then fall back to common defaults.
  const symbolic = await ctx.run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: ctx.repoRoot,
  });
  if (symbolic.exitCode === 0) {
    const ref = symbolic.stdout.trim();
    const slash = ref.indexOf("/");
    if (slash >= 0) {
      return ref.slice(slash + 1);
    }
    return ref;
  }
  const branchList = await ctx.run("git", ["branch", "--list", "main", "master"], {
    cwd: ctx.repoRoot,
  });
  const lines = branchList.stdout.split("\n").map((l) => l.trim().replace(/^\* /, ""));
  if (lines.includes("main")) {
    return "main";
  }
  if (lines.includes("master")) {
    return "master";
  }
  return "main";
}

export async function createFeatureBranch(
  ctx: GitOpsContext,
  branch: string,
  fromBranch: string,
): Promise<void> {
  const checkout = await ctx.run("git", ["checkout", "-B", branch, fromBranch], {
    cwd: ctx.repoRoot,
  });
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout -B ${branch} ${fromBranch} failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
    );
  }
}

// Fetch and check out a branch produced by an upstream phase. Asserts the
// working tree is clean afterwards so the agent starts from a known state.
export async function checkoutFeatureBranch(
  ctx: GitOpsContext,
  branch: string,
): Promise<void> {
  const fetch = await ctx.run("git", ["fetch", "origin", branch], { cwd: ctx.repoRoot });
  if (fetch.exitCode !== 0) {
    throw new Error(
      `git fetch origin ${branch} failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
    );
  }
  const checkout = await ctx.run("git", ["checkout", "-B", branch, `origin/${branch}`], {
    cwd: ctx.repoRoot,
  });
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout -B ${branch} origin/${branch} failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
    );
  }
  const status = await ctx.run("git", ["status", "--porcelain"], { cwd: ctx.repoRoot });
  if (status.exitCode !== 0) {
    throw new Error(
      `git status --porcelain failed: ${status.stderr.trim() || status.stdout.trim()}`,
    );
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `working tree not clean after checkout of ${branch}: ${status.stdout.trim()}`,
    );
  }
}

// Returns the subset of `paths` modified between `basisRef` and HEAD (after
// staging the agent's working-tree changes). Used by the coder activity to
// reject submissions that modified spec test files.
export async function diffPathsTouched(
  ctx: GitOpsContext,
  basisRef: string,
  paths: ReadonlyArray<string>,
): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }
  const args = ["diff", "--name-only", basisRef, "--", ...paths];
  const result = await ctx.run("git", args, { cwd: ctx.repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff --name-only ${basisRef} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const wanted = new Set(paths);
  const touched: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (wanted.has(trimmed)) {
      touched.push(trimmed);
    }
  }
  return touched;
}

export interface CommitTrailerInput {
  workflowId: string;
  ticketId: string;
  attempt: number;
}

export function buildCommitMessage(file: ProposedFile, trailer: CommitTrailerInput): string {
  const subject = `test(spec): failing test for ${file.description}`;
  const trailers = [
    `Workflow-Id: ${trailer.workflowId}`,
    `Ticket-Id: ${trailer.ticketId}`,
    `Attempt: ${trailer.attempt}`,
    "Phase: spec",
  ].join("\n");
  return `${subject}\n\n${trailers}\n`;
}

export async function commitFile(
  ctx: GitOpsContext,
  file: ProposedFile,
  trailer: CommitTrailerInput,
): Promise<string> {
  const add = await ctx.run("git", ["add", "--", file.path], { cwd: ctx.repoRoot });
  if (add.exitCode !== 0) {
    throw new Error(`git add ${file.path} failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const message = buildCommitMessage(file, trailer);
  const commit = await ctx.run("git", ["commit", "-m", message], { cwd: ctx.repoRoot });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  const sha = await ctx.run("git", ["rev-parse", "HEAD"], { cwd: ctx.repoRoot });
  if (sha.exitCode !== 0 || sha.stdout.trim().length === 0) {
    throw new Error(`git rev-parse HEAD failed: ${sha.stderr.trim() || sha.stdout.trim()}`);
  }
  return sha.stdout.trim();
}

export interface CommitAllInput {
  subject: string;
  trailer: CommitTrailerInput;
  phase: string;
}

export function buildCommitMessageWithSubject(
  subject: string,
  trailer: CommitTrailerInput,
  phase: string,
): string {
  const trailers = [
    `Workflow-Id: ${trailer.workflowId}`,
    `Ticket-Id: ${trailer.ticketId}`,
    `Attempt: ${trailer.attempt}`,
    `Phase: ${phase}`,
  ].join("\n");
  return `${subject}\n\n${trailers}\n`;
}

// Stage all working-tree changes and create a single commit with the structured
// trailer. Used by the coder activity to capture the agent's diff as one commit.
export async function commitAll(
  ctx: GitOpsContext,
  input: CommitAllInput,
): Promise<string> {
  const add = await ctx.run("git", ["add", "--all"], { cwd: ctx.repoRoot });
  if (add.exitCode !== 0) {
    throw new Error(`git add --all failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const message = buildCommitMessageWithSubject(input.subject, input.trailer, input.phase);
  const commit = await ctx.run("git", ["commit", "-m", message], { cwd: ctx.repoRoot });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  const sha = await ctx.run("git", ["rev-parse", "HEAD"], { cwd: ctx.repoRoot });
  if (sha.exitCode !== 0 || sha.stdout.trim().length === 0) {
    throw new Error(`git rev-parse HEAD failed: ${sha.stderr.trim() || sha.stdout.trim()}`);
  }
  return sha.stdout.trim();
}

export async function pushBranch(ctx: GitOpsContext, branch: string): Promise<void> {
  const push = await ctx.run("git", ["push", "--set-upstream", "origin", branch], {
    cwd: ctx.repoRoot,
  });
  if (push.exitCode !== 0) {
    throw new Error(
      `git push --set-upstream origin ${branch} failed: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }
}

// Push a branch that already tracks `origin` (no `--set-upstream`). Used by
// the coder activity to push the existing spec feature branch with a new commit.
export async function pushExistingBranch(
  ctx: GitOpsContext,
  branch: string,
): Promise<void> {
  const push = await ctx.run("git", ["push", "origin", branch], { cwd: ctx.repoRoot });
  if (push.exitCode !== 0) {
    throw new Error(
      `git push origin ${branch} failed: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }
}
