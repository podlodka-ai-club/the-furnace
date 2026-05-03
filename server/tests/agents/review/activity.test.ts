import { describe, expect, it } from "vitest";
import {
  reconcileFindingsWithDiff,
  runReviewAgent,
  type RunReviewAgentDeps,
} from "../../../src/agents/review/activity.js";
import type {
  ReviewAgentClient,
  ReviewAgentDecision,
  ReviewAgentRunOptions,
  ReviewAgentSession,
} from "../../../src/agents/review/agent.js";
import type { ReviewerInput, ReviewResult } from "../../../src/agents/contracts/index.js";
import type {
  RunCommand,
  RunCommandOptions,
} from "../../../src/agents/shared/repo-ops.js";

interface RecordedCall {
  command: string;
  args: string[];
  options: RunCommandOptions;
}

function makeInput(overrides: Partial<ReviewerInput> = {}): ReviewerInput {
  return {
    ticket: {
      id: "ticket_1",
      identifier: "ENG-1",
      title: "Implement",
      description: "do it",
    },
    featureBranch: "agent/eng-1",
    finalCommitSha: "a".repeat(40),
    diffStat: { filesChanged: 1, insertions: 10, deletions: 0 },
    testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
    prNumber: 42,
    round: 0,
    ...overrides,
  };
}

function makeStubClient(decision: ReviewAgentDecision): {
  client: ReviewAgentClient;
  startCount: () => number;
  startedAt: () => number;
} {
  let startedSequence = -1;
  let cwdAtStart: string | undefined;
  void cwdAtStart;
  const client: ReviewAgentClient = {
    async startSession(options: ReviewAgentRunOptions): Promise<ReviewAgentSession> {
      startedSequence = sequenceCounter++;
      cwdAtStart = options.cwd;
      return {
        async next(): Promise<ReviewAgentDecision> {
          return decision;
        },
        async close() {},
      };
    },
  };
  return {
    client,
    startCount: () => (startedSequence >= 0 ? 1 : 0),
    startedAt: () => startedSequence,
  };
}

let sequenceCounter = 0;

describe("runReviewAgent — pre-session checkout", () => {
  it("checks out the feature branch BEFORE starting the SDK session", async () => {
    sequenceCounter = 0;
    const calls: Array<{ kind: string; sequence: number }> = [];
    const runCommand: RunCommand = async (command, args) => {
      calls.push({ kind: `${command} ${args.join(" ")}`, sequence: sequenceCounter++ });
      // git status --porcelain must report a clean tree to satisfy
      // checkoutFeatureBranch's post-condition.
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const validResult: ReviewResult = {
      verdict: "approve",
      reasoning: "ok",
      findings: [],
    };
    const stub = makeStubClient({ type: "submit_review", input: validResult });

    const deps: RunReviewAgentDeps = {
      agentClient: stub.client,
      loadPrompt: async () => "Review {{FEATURE_BRANCH}} at {{FINAL_COMMIT_SHA}}.",
      resolveRepoPath: () => "/tmp/test-repo",
      runCommand,
    };

    await runReviewAgent(makeInput({ featureBranch: "agent/eng-1" }), deps);

    const fetchCall = calls.find((c) => c.kind.startsWith("git fetch"));
    const checkoutCall = calls.find((c) => c.kind.startsWith("git checkout"));
    expect(fetchCall).toBeDefined();
    expect(checkoutCall).toBeDefined();
    expect(fetchCall!.kind).toBe("git fetch origin agent/eng-1");
    expect(checkoutCall!.kind).toBe(
      "git checkout -B agent/eng-1 origin/agent/eng-1",
    );
    // The agent SDK session must start AFTER the checkout completed.
    expect(stub.startedAt()).toBeGreaterThan(checkoutCall!.sequence);
  });

  it("propagates checkout failure without starting the SDK session", async () => {
    sequenceCounter = 0;
    const runCommand: RunCommand = async (command, args) => {
      if (command === "git" && args[0] === "fetch") {
        return { exitCode: 1, stdout: "", stderr: "fatal: branch not found" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const validResult: ReviewResult = {
      verdict: "approve",
      reasoning: "ok",
      findings: [],
    };
    const stub = makeStubClient({ type: "submit_review", input: validResult });

    await expect(
      runReviewAgent(makeInput(), {
        agentClient: stub.client,
        loadPrompt: async () => "x",
        resolveRepoPath: () => "/tmp/test-repo",
        runCommand,
      }),
    ).rejects.toThrow(/git fetch/);
    expect(stub.startCount()).toBe(0);
  });
});

describe("reconcileFindingsWithDiff", () => {
  it("returns the result unchanged when every finding's path is in the diff", () => {
    const result: ReviewResult = {
      verdict: "changes_requested",
      reasoning: "One bug remains.",
      findings: [
        { path: "src/foo.ts", line: 12, severity: "blocking", message: "off by one" },
        { path: "src/bar.ts", severity: "advisory", message: "naming nit" },
      ],
    };
    const out = reconcileFindingsWithDiff(result, ["src/foo.ts", "src/bar.ts"]);
    expect(out).toBe(result);
  });

  it("drops findings whose path is not in the diff and folds them into reasoning", () => {
    const result: ReviewResult = {
      verdict: "changes_requested",
      reasoning: "Coverage gap in handler.",
      findings: [
        { path: "src/foo.ts", line: 12, severity: "blocking", message: "off by one" },
        {
          path: "tests/old-suite.ts",
          line: 3,
          severity: "blocking",
          message: "reviewer thought this should change",
        },
        { path: "docs/missing.md", severity: "advisory", message: "docs untouched" },
      ],
    };
    const out = reconcileFindingsWithDiff(result, ["src/foo.ts"]);

    expect(out.verdict).toBe("changes_requested");
    expect(out.findings).toEqual([
      { path: "src/foo.ts", line: 12, severity: "blocking", message: "off by one" },
    ]);
    expect(out.reasoning).toContain("Coverage gap in handler.");
    expect(out.reasoning).toContain("Out-of-diff notes");
    expect(out.reasoning).toContain("tests/old-suite.ts:3");
    expect(out.reasoning).toContain("docs/missing.md");
    expect(out.reasoning).toContain("reviewer thought this should change");
    expect(out.reasoning).toContain("docs untouched");
    // Severity tag preserved.
    expect(out.reasoning).toContain("[blocking]");
    expect(out.reasoning).toContain("[advisory]");
  });

  it("preserves verdict when all findings are dropped (caller decides what to do)", () => {
    const result: ReviewResult = {
      verdict: "changes_requested",
      reasoning: "Bad shape.",
      findings: [
        { path: "src/gone.ts", line: 1, severity: "blocking", message: "this file is not in diff" },
      ],
    };
    const out = reconcileFindingsWithDiff(result, ["src/foo.ts"]);
    expect(out.findings).toEqual([]);
    expect(out.verdict).toBe("changes_requested");
    expect(out.reasoning).toContain("src/gone.ts:1");
  });
});
