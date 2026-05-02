import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkoutFeatureBranch,
  commitAll,
  defaultRunCommand,
  diffPathsTouched,
  type GitOpsContext,
} from "../../../src/agents/shared/repo-ops.js";

// These tests exercise the shared repo-ops helpers against a real temp git
// repo (not stubbed runCommand) — important because they validate that the
// helpers' git invocations actually work end-to-end.

let tmpRoot: string;
let originPath: string;
let workPath: string;
let ctx: GitOpsContext;

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await defaultRunCommand("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`,
    );
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "furnace-shared-repo-"));
  originPath = path.join(tmpRoot, "origin.git");
  workPath = path.join(tmpRoot, "work");

  // Bare origin.
  await mkdir(originPath, { recursive: true });
  await git(originPath, ["init", "--bare", "--initial-branch=main"]);

  // Working clone.
  await git(tmpRoot, ["clone", originPath, workPath]);
  // Quiet local commit identity so commit operations don't fail in CI.
  await git(workPath, ["config", "user.email", "test@example.com"]);
  await git(workPath, ["config", "user.name", "Test"]);
  // Seed an initial commit on main so we have HEAD to branch from.
  await writeFile(path.join(workPath, "README.md"), "seed\n", "utf8");
  await git(workPath, ["add", "README.md"]);
  await git(workPath, ["commit", "-m", "seed"]);
  await git(workPath, ["push", "-u", "origin", "main"]);

  ctx = { repoRoot: workPath, run: defaultRunCommand };
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("checkoutFeatureBranch", () => {
  it("fetches and checks out an existing remote branch with a clean tree", async () => {
    // Push a feature branch from main on origin.
    await git(workPath, ["checkout", "-B", "agent/spec-eng-1"]);
    await writeFile(path.join(workPath, "feature.ts"), "export const x = 1;\n", "utf8");
    await git(workPath, ["add", "feature.ts"]);
    await git(workPath, ["commit", "-m", "feature commit"]);
    await git(workPath, ["push", "-u", "origin", "agent/spec-eng-1"]);

    // Switch back to main and re-check it out via the helper.
    await git(workPath, ["checkout", "main"]);
    await checkoutFeatureBranch(ctx, "agent/spec-eng-1");

    const head = await defaultRunCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workPath,
    });
    expect(head.stdout.trim()).toBe("agent/spec-eng-1");
  });

  it("throws if working tree is dirty after checkout", async () => {
    await git(workPath, ["checkout", "-B", "agent/dirty"]);
    await writeFile(path.join(workPath, "feature.ts"), "export const x = 1;\n", "utf8");
    await git(workPath, ["add", "feature.ts"]);
    await git(workPath, ["commit", "-m", "feature"]);
    await git(workPath, ["push", "-u", "origin", "agent/dirty"]);
    // Leave behind an uncommitted change after checkout.
    await writeFile(path.join(workPath, "feature.ts"), "export const x = 99;\n", "utf8");

    await expect(checkoutFeatureBranch(ctx, "agent/dirty")).rejects.toThrow(/working tree not clean/);
  });
});

describe("diffPathsTouched", () => {
  it("returns the subset of paths modified between basis and HEAD", async () => {
    const basis = (
      await defaultRunCommand("git", ["rev-parse", "HEAD"], { cwd: workPath })
    ).stdout.trim();

    await writeFile(path.join(workPath, "a.ts"), "a\n", "utf8");
    await writeFile(path.join(workPath, "b.ts"), "b\n", "utf8");
    await git(workPath, ["add", "a.ts", "b.ts"]);
    await git(workPath, ["commit", "-m", "add a and b"]);

    const touched = await diffPathsTouched(ctx, basis, ["a.ts", "c.ts"]);
    expect(touched).toEqual(["a.ts"]);
  });

  it("returns [] when no requested paths changed", async () => {
    const basis = (
      await defaultRunCommand("git", ["rev-parse", "HEAD"], { cwd: workPath })
    ).stdout.trim();

    await writeFile(path.join(workPath, "x.ts"), "x\n", "utf8");
    await git(workPath, ["add", "x.ts"]);
    await git(workPath, ["commit", "-m", "add x"]);

    const touched = await diffPathsTouched(ctx, basis, ["protected.ts"]);
    expect(touched).toEqual([]);
  });

  it("returns [] when paths array is empty (no git invocation)", async () => {
    const head = (
      await defaultRunCommand("git", ["rev-parse", "HEAD"], { cwd: workPath })
    ).stdout.trim();

    const touched = await diffPathsTouched(ctx, head, []);
    expect(touched).toEqual([]);
  });
});

describe("commitAll", () => {
  it("stages all changes and produces a commit with structured trailer", async () => {
    await writeFile(path.join(workPath, "src.ts"), "export const v = 1;\n", "utf8");

    const sha = await commitAll(ctx, {
      subject: "feat(coder): make spec tests green for ENG-1",
      trailer: { workflowId: "ticket-1", ticketId: "issue_1", attempt: 2 },
      phase: "coder",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const message = (
      await defaultRunCommand("git", ["log", "-1", "--pretty=%B", sha], { cwd: workPath })
    ).stdout;
    expect(message).toContain("feat(coder): make spec tests green for ENG-1");
    expect(message).toContain("Workflow-Id: ticket-1");
    expect(message).toContain("Ticket-Id: issue_1");
    expect(message).toContain("Attempt: 2");
    expect(message).toContain("Phase: coder");
  });
});
