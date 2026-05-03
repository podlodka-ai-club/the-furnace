import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import {
  CODER_FAILURE_TYPES,
  buildStuckBody,
  buildWorkflowDeepLink,
  parseShortStat,
  parseTestRunSummary,
  renderPrompt,
  runCoderPhase,
  type CoderPhaseInput,
  type RunCoderPhaseDeps,
} from "../../../src/agents/coder/activity.js";
import type {
  CoderAgentClient,
  CoderAgentDecision,
  CoderAgentRunOptions,
  CoderAgentSession,
} from "../../../src/agents/coder/agent.js";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../src/agents/shared/repo-ops.js";
import type {
  CreatedSubTicket,
  LinearClientApi,
} from "../../../src/linear/types.js";
import { validImplementationPlan } from "../contracts/fixtures.js";

const TICKET = {
  id: "issue_42",
  identifier: "ENG-77",
  title: "Implement feature Y",
  description: "User can do Y.",
} as const;

const SPEC_OUTPUT = {
  featureBranch: "agent/spec-eng-77",
  testCommits: [
    {
      sha: "a".repeat(40),
      path: "tests/feature-y.test.ts",
      description: "covers feature Y",
    },
  ],
  implementationPlan: validImplementationPlan,
};

function makeStubSession(decisions: CoderAgentDecision[]): {
  session: CoderAgentSession;
  calls: { correctiveMessage?: string }[];
} {
  const calls: { correctiveMessage?: string }[] = [];
  let index = 0;
  const session: CoderAgentSession = {
    next: async (correctiveMessage?: string) => {
      calls.push({ correctiveMessage });
      if (index >= decisions.length) {
        throw new Error(`stub session ran out of decisions at call ${index + 1}`);
      }
      return decisions[index++];
    },
    close: async () => {},
  };
  return { session, calls };
}

function makeStubAgentClient(decisions: CoderAgentDecision[]): {
  client: CoderAgentClient;
  calls: { correctiveMessage?: string }[];
  opts: CoderAgentRunOptions[];
} {
  const opts: CoderAgentRunOptions[] = [];
  const { session, calls } = makeStubSession(decisions);
  const client: CoderAgentClient = {
    startSession: async (options) => {
      opts.push(options);
      return session;
    },
  };
  return { client, calls, opts };
}

interface ScriptedStep {
  match: (command: string, args: string[]) => boolean;
  result: RunCommandResult;
}

function makeScriptedRunCommand(steps: ScriptedStep[]): {
  run: RunCommand;
  calls: { command: string; args: string[]; cwd: string }[];
} {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let cursor = 0;
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    while (cursor < steps.length) {
      const step = steps[cursor];
      if (step.match(command, args)) {
        cursor++;
        return step.result;
      }
      cursor++;
    }
    throw new Error(
      `unexpected runCommand call: ${command} ${args.join(" ")} (no matching scripted step)`,
    );
  };
  return { run, calls };
}

function ok(stdout = ""): RunCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failResult(stdout = "", stderr = "fail"): RunCommandResult {
  return { exitCode: 1, stdout, stderr };
}

const PASSING_RUN_OUT = "Tests  3 passed (3)\n";

const NOOP_LINEAR_CLIENT: LinearClientApi = {
  listAgentReadyTickets: async () => [],
  createSubTicket: async () => {
    throw new Error("createSubTicket should not be called on this path");
  },
  postComment: async () => ({ id: "x" }),
  updateIssueState: async () => {},
};

function makeBaseDeps(overrides: Partial<RunCoderPhaseDeps> = {}): RunCoderPhaseDeps {
  return {
    loadPrompt: async () => "coder system prompt {{TICKET_IDENTIFIER}}",
    resolveWorkflowMeta: () => ({
      workflowId: "ticket-issue_42",
      namespace: "default",
      attempt: 1,
    }),
    resolveWebBase: () => "http://localhost:8233",
    resolveCorrectionBudget: () => 3,
    linearClient: NOOP_LINEAR_CLIENT,
    ...overrides,
  };
}

function happyPathSteps(): ScriptedStep[] {
  return [
    // checkoutFeatureBranch: fetch
    { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
    // checkoutFeatureBranch: checkout -B
    { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
    // checkoutFeatureBranch: status --porcelain (clean)
    { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
    // getHeadSha (preAgentSha)
    {
      match: (c, a) => c === "git" && a[0] === "rev-parse",
      result: ok(`${"a".repeat(40)}\n`),
    },
    // diffPathsTouched: no test paths touched
    {
      match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
      result: ok(""),
    },
    // npm test (passes)
    {
      match: (c, a) => c === "npm" && a[0] === "test",
      result: ok(PASSING_RUN_OUT),
    },
    // hasWorkingTreeChanges: status --porcelain (dirty → has changes)
    {
      match: (c, a) => c === "git" && a[0] === "status" && a[1] === "--porcelain",
      result: ok(" M src/server.js\n"),
    },
    // commitAll: git add --all
    { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
    // commitAll: git commit
    { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
    // commitAll: git rev-parse HEAD (final SHA)
    {
      match: (c, a) => c === "git" && a[0] === "rev-parse",
      result: ok(`${"b".repeat(40)}\n`),
    },
    // pushExistingBranch: git push origin <branch>
    { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
    // readDiffStat: git diff --shortstat
    {
      match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--shortstat",
      result: ok(" 2 files changed, 10 insertions(+), 1 deletion(-)\n"),
    },
  ];
}

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), "furnace-coder-activity-"));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("runCoderPhase", () => {
  it("10.1 happy path: tests pass on first verification, single commit + push", async () => {
    const { client, opts: agentOpts } = makeStubAgentClient([
      { type: "submit_implementation", input: { summary: "fixed it" } },
    ]);

    const { run, calls } = makeScriptedRunCommand(happyPathSteps());

    const input: CoderPhaseInput = { ticket: TICKET, specOutput: SPEC_OUTPUT };
    const output = await runCoderPhase(
      input,
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    expect(output.featureBranch).toBe(SPEC_OUTPUT.featureBranch);
    expect(output.finalCommitSha).toBe("b".repeat(40));
    expect(output.diffStat).toEqual({ filesChanged: 2, insertions: 10, deletions: 1 });
    expect(output.testRunSummary).toEqual({ total: 3, passed: 3, failed: 0, durationMs: expect.any(Number) });

    // Agent prompt was rendered.
    expect(agentOpts[0].systemPrompt).toContain("ENG-77");

    // Sanity-check the commit subject got into git commit args.
    const commitCall = calls.find((c) => c.command === "git" && c.args[0] === "commit");
    const messageArg = commitCall?.args[2] ?? "";
    expect(messageArg).toContain("feat(coder): make spec tests green for ENG-77");
    expect(messageArg).toContain("Workflow-Id: ticket-issue_42");
    expect(messageArg).toContain("Phase: coder");
  });

  it("10.2 false-pass correction loop: tests fail, corrective sent, second submission passes", async () => {
    const { client, calls: agentCalls } = makeStubAgentClient([
      { type: "submit_implementation", input: { summary: "first try" } },
      { type: "submit_implementation", input: { summary: "second try" } },
    ]);

    const { run } = makeScriptedRunCommand([
      // checkoutFeatureBranch
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      // preAgentSha
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
      // First submission: diffPathsTouched (clean), test run fails
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
        result: ok(""),
      },
      {
        match: (c, a) => c === "npm" && a[0] === "test",
        result: failResult("", "AssertionError: still red"),
      },
      // Second submission: diffPathsTouched (clean), test run passes
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
        result: ok(""),
      },
      {
        match: (c, a) => c === "npm" && a[0] === "test",
        result: ok(PASSING_RUN_OUT),
      },
      // hasWorkingTreeChanges: dirty
      {
        match: (c, a) => c === "git" && a[0] === "status" && a[1] === "--porcelain",
        result: ok(" M src/foo.ts\n"),
      },
      // commitAll
      { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"b".repeat(40)}\n`),
      },
      { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--shortstat",
        result: ok(" 1 file changed, 5 insertions(+)\n"),
      },
    ]);

    const output = await runCoderPhase(
      { ticket: TICKET, specOutput: SPEC_OUTPUT },
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    expect(output.finalCommitSha).toBe("b".repeat(40));
    // Second next() received corrective text mentioning runner output.
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1].correctiveMessage).toContain("test command still exits non-zero");
    expect(agentCalls[1].correctiveMessage).toContain("AssertionError: still red");
  });

  it("10.3 test-file modification: corrective names path, second submission has clean test paths", async () => {
    const { client, calls: agentCalls } = makeStubAgentClient([
      { type: "submit_implementation", input: { summary: "first try" } },
      { type: "submit_implementation", input: { summary: "second try" } },
    ]);

    const { run } = makeScriptedRunCommand([
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
      // First submission: diffPathsTouched returns the spec test path
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
        result: ok("tests/feature-y.test.ts\n"),
      },
      // Second submission: diffPathsTouched clean, npm test passes
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
        result: ok(""),
      },
      {
        match: (c, a) => c === "npm" && a[0] === "test",
        result: ok(PASSING_RUN_OUT),
      },
      // hasWorkingTreeChanges: dirty
      {
        match: (c, a) => c === "git" && a[0] === "status" && a[1] === "--porcelain",
        result: ok(" M src/foo.ts\n"),
      },
      { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"b".repeat(40)}\n`),
      },
      { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--shortstat",
        result: ok(" 1 file changed, 1 insertion(+)\n"),
      },
    ]);

    const output = await runCoderPhase(
      { ticket: TICKET, specOutput: SPEC_OUTPUT },
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    expect(output.finalCommitSha).toBe("b".repeat(40));
    expect(agentCalls[1].correctiveMessage).toContain("tests/feature-y.test.ts");
    expect(agentCalls[1].correctiveMessage).toMatch(/modified one or more spec test files/i);
  });

  it("10.3.1 empty-diff submission: corrective sent, second submission with real changes succeeds", async () => {
    const { client, calls: agentCalls } = makeStubAgentClient([
      { type: "submit_implementation", input: { summary: "first try" } },
      { type: "submit_implementation", input: { summary: "second try" } },
    ]);

    const { run } = makeScriptedRunCommand([
      // checkoutFeatureBranch
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      // preAgentSha
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
      // First submission: diffPathsTouched clean, tests pass, but working tree is empty
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
        result: ok(""),
      },
      {
        match: (c, a) => c === "npm" && a[0] === "test",
        result: ok(PASSING_RUN_OUT),
      },
      // hasWorkingTreeChanges: empty → corrective nudge
      {
        match: (c, a) => c === "git" && a[0] === "status" && a[1] === "--porcelain",
        result: ok(""),
      },
      // Second submission: diffPathsTouched clean, tests pass, working tree dirty
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-only",
        result: ok(""),
      },
      {
        match: (c, a) => c === "npm" && a[0] === "test",
        result: ok(PASSING_RUN_OUT),
      },
      {
        match: (c, a) => c === "git" && a[0] === "status" && a[1] === "--porcelain",
        result: ok(" M src/foo.ts\n"),
      },
      { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"b".repeat(40)}\n`),
      },
      { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
      {
        match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--shortstat",
        result: ok(" 1 file changed, 1 insertion(+)\n"),
      },
    ]);

    const priorReview = {
      prNumber: 42,
      reviewSummary: "Edge case missing.",
      findings: [
        {
          path: "src/foo.ts",
          line: 12,
          severity: "blocking" as const,
          message: "Handle empty input.",
        },
      ],
    };

    const output = await runCoderPhase(
      { ticket: TICKET, specOutput: SPEC_OUTPUT, priorReview },
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    expect(output.finalCommitSha).toBe("b".repeat(40));
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1].correctiveMessage).toMatch(/working tree is identical to HEAD/i);
    expect(agentCalls[1].correctiveMessage).toContain("src/foo.ts:12");
    expect(agentCalls[1].correctiveMessage).toContain("Handle empty input.");
  });

  it("10.4 prose-only correction budget exhaustion: retryable error after budget", async () => {
    const { client, calls: agentCalls } = makeStubAgentClient([
      { type: "no_tool_call" },
      { type: "no_tool_call" },
      { type: "no_tool_call" },
      { type: "no_tool_call" },
    ]);

    const { run } = makeScriptedRunCommand([
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
    ]);

    await expect(
      runCoderPhase(
        { ticket: TICKET, specOutput: SPEC_OUTPUT },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          resolveRepoPath: () => repoPath,
          resolveCorrectionBudget: () => 3,
        }),
      ),
    ).rejects.toMatchObject({
      type: CODER_FAILURE_TYPES.toolBudgetExhausted,
      nonRetryable: false,
    });

    // 1 initial decision + 3 corrective nudges before fail = 4 next() calls.
    expect(agentCalls).toHaveLength(4);
  });

  it("10.5 report_dep_missing: opens sub-ticket and throws non-retryable DepMissingRequested", async () => {
    const { client } = makeStubAgentClient([
      {
        type: "report_dep_missing",
        input: {
          reason: "Need an HTTP client library to call the new API.",
          dependency: "axios",
          questions: ["Which version range is acceptable?"],
        },
      },
    ]);

    const { run } = makeScriptedRunCommand([
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
    ]);

    let createdBody: string | null = null;
    let createdLink: string | null = null;
    let createdType: string | null = null;
    const linearClient: LinearClientApi = {
      ...NOOP_LINEAR_CLIENT,
      createSubTicket: async (parentId, type, body, deepLink): Promise<CreatedSubTicket> => {
        createdType = type;
        createdBody = body;
        createdLink = deepLink;
        return { id: "issue_dep", identifier: "ENG-100", title: `dep-missing for ENG-77` };
      },
    };

    await expect(
      runCoderPhase(
        { ticket: TICKET, specOutput: SPEC_OUTPUT },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          resolveRepoPath: () => repoPath,
          linearClient,
        }),
      ),
    ).rejects.toMatchObject({
      type: CODER_FAILURE_TYPES.depMissingRequested,
      nonRetryable: true,
      details: [
        {
          subTicketRef: {
            id: "issue_dep",
            identifier: "ENG-100",
            title: expect.any(String),
          },
        },
      ],
    });

    expect(createdType).toBe("dep-missing");
    expect(createdBody).toContain("Need an HTTP client library");
    expect(createdBody).toContain("**Missing dependency:** axios");
    expect(createdBody).toContain("- [ ] Which version range is acceptable?");
    expect(createdLink).toContain("/namespaces/default/workflows/ticket-issue_42");
  });

  it("10.6 report_design_question: opens sub-ticket and throws DesignQuestionRequested", async () => {
    const { client } = makeStubAgentClient([
      {
        type: "report_design_question",
        input: {
          reason: "Architectural choice between event-sourcing and CRUD.",
          questions: ["Which approach?", "Where do we draw the boundary?"],
        },
      },
    ]);

    const { run } = makeScriptedRunCommand([
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
    ]);

    let createdType: string | null = null;
    let createdBody: string | null = null;
    const linearClient: LinearClientApi = {
      ...NOOP_LINEAR_CLIENT,
      createSubTicket: async (parentId, type, body): Promise<CreatedSubTicket> => {
        createdType = type;
        createdBody = body;
        return { id: "issue_dq", identifier: "ENG-101", title: "design-question for ENG-77" };
      },
    };

    await expect(
      runCoderPhase(
        { ticket: TICKET, specOutput: SPEC_OUTPUT },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          resolveRepoPath: () => repoPath,
          linearClient,
        }),
      ),
    ).rejects.toMatchObject({
      type: CODER_FAILURE_TYPES.designQuestionRequested,
      nonRetryable: true,
    });

    expect(createdType).toBe("design-question");
    expect(createdBody).toContain("Architectural choice");
    expect(createdBody).not.toContain("**Missing dependency:**");
    expect(createdBody).toContain("- [ ] Which approach?");
  });

  it("10.7 Linear outage during createSubTicket produces a retryable error", async () => {
    const { client } = makeStubAgentClient([
      {
        type: "report_dep_missing",
        input: {
          reason: "Need a library.",
          dependency: "axios",
          questions: ["Version?"],
        },
      },
    ]);

    const { run } = makeScriptedRunCommand([
      { match: (c, a) => c === "git" && a[0] === "fetch", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "status", result: ok("") },
      {
        match: (c, a) => c === "git" && a[0] === "rev-parse",
        result: ok(`${"a".repeat(40)}\n`),
      },
    ]);

    const linearClient: LinearClientApi = {
      ...NOOP_LINEAR_CLIENT,
      createSubTicket: async () => {
        throw new Error("Linear API 503");
      },
    };

    await expect(
      runCoderPhase(
        { ticket: TICKET, specOutput: SPEC_OUTPUT },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          resolveRepoPath: () => repoPath,
          linearClient,
        }),
      ),
    ).rejects.toMatchObject({
      type: "LinearSubTicketCreationFailed",
      nonRetryable: false,
    });
  });

  it("10.8 invalid input throws non-retryable InvalidCoderPhaseInput", async () => {
    await expect(
      runCoderPhase(
        // missing ticket
        { specOutput: SPEC_OUTPUT } as unknown as CoderPhaseInput,
        makeBaseDeps({ resolveRepoPath: () => repoPath }),
      ),
    ).rejects.toMatchObject({
      type: CODER_FAILURE_TYPES.invalidInput,
      nonRetryable: true,
    });
  });

  it("10.8 invalid output (forced via stubbed return) throws before reaching the workflow", async () => {
    const { client } = makeStubAgentClient([
      { type: "submit_implementation", input: { summary: "fixed it" } },
    ]);

    // Mirror happyPathSteps but make the post-commit `git rev-parse HEAD`
    // (used by commitAll for finalCommitSha) return a value that fails
    // commitShaSchema's 40-char-hex regex. coderPhaseOutputSchema.parse must
    // throw rather than return a malformed payload.
    const steps = happyPathSteps();
    const finalShaIdx = steps.findIndex(
      (s, i) => i > 6 && s.match("git", ["rev-parse", "HEAD"]),
    );
    steps[finalShaIdx] = {
      match: (c, a) => c === "git" && a[0] === "rev-parse",
      result: ok("not-a-sha\n"),
    };
    const { run } = makeScriptedRunCommand(steps);

    const promise = runCoderPhase(
      { ticket: TICKET, specOutput: SPEC_OUTPUT },
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    await expect(promise).rejects.toThrow(/40-character git SHA/);
    // The schema error must not be wrapped as a successful output, and must
    // not present as the InvalidCoderPhaseInput failure (which only fires at
    // entry).
    await expect(promise).rejects.not.toMatchObject({
      type: CODER_FAILURE_TYPES.invalidInput,
    });
  });
});

describe("renderPrompt", () => {
  it("interpolates ticket, repo path, branch, and test files", () => {
    const out = renderPrompt(
      "ID={{TICKET_IDENTIFIER}} TITLE={{TICKET_TITLE}} DESC={{TICKET_DESCRIPTION}} REPO={{WORKER_REPO_PATH}} BR={{FEATURE_BRANCH}} FILES=\n{{TEST_FILES}}",
      TICKET,
      SPEC_OUTPUT,
      "/workspace",
    );
    expect(out).toContain("ID=ENG-77");
    expect(out).toContain("TITLE=Implement feature Y");
    expect(out).toContain("DESC=User can do Y.");
    expect(out).toContain("REPO=/workspace");
    expect(out).toContain("BR=agent/spec-eng-77");
    expect(out).toContain("- `tests/feature-y.test.ts`");
  });

  it("substitutes (no description) when ticket description is empty", () => {
    const out = renderPrompt(
      "DESC={{TICKET_DESCRIPTION}}",
      { ...TICKET, description: "" },
      SPEC_OUTPUT,
      "/workspace",
    );
    expect(out).toBe("DESC=(no description)");
  });

  it("renders empty prior-review section on round 0 (no priorReview)", () => {
    const out = renderPrompt(
      "BEFORE\n{{PRIOR_REVIEW_SECTION}}\nAFTER",
      TICKET,
      SPEC_OUTPUT,
      "/workspace",
    );
    expect(out).toBe("BEFORE\n\nAFTER");
    expect(out).not.toContain("Prior reviewer feedback");
  });

  it("renders prior-review section with all findings on follow-up rounds", () => {
    const out = renderPrompt(
      "BEFORE\n{{PRIOR_REVIEW_SECTION}}\nAFTER",
      TICKET,
      SPEC_OUTPUT,
      "/workspace",
      {
        prNumber: 42,
        reviewSummary: "Looks close but two issues remain.",
        findings: [
          {
            path: "src/foo.ts",
            line: 10,
            severity: "blocking",
            message: "Null check missing",
          },
          {
            path: "src/bar.ts",
            severity: "advisory",
            message: "Consider extracting helper",
          },
        ],
      },
    );
    expect(out).toContain("## Prior reviewer feedback");
    expect(out).toContain("PR #42");
    expect(out).toContain("Looks close but two issues remain.");
    expect(out).toContain("[blocking] src/foo.ts:10 — Null check missing");
    expect(out).toContain("[advisory] src/bar.ts — Consider extracting helper");
  });

  it("renders prior-review section with no-findings placeholder when findings array is empty", () => {
    const out = renderPrompt(
      "{{PRIOR_REVIEW_SECTION}}",
      TICKET,
      SPEC_OUTPUT,
      "/workspace",
      {
        prNumber: 7,
        reviewSummary: "Approved with notes.",
        findings: [],
      },
    );
    expect(out).toContain("## Prior reviewer feedback");
    expect(out).toContain("(no findings)");
  });

  it("5.3 renders the plan with exactly one `## Implementation plan` heading (regression guard)", async () => {
    const promptUrl = new URL("../../../src/agents/coder/prompt.md", import.meta.url);
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const template = await readFile(fileURLToPath(promptUrl), "utf8");

    const out = renderPrompt(template, TICKET, SPEC_OUTPUT, "/workspace");

    const headingMatches = out.match(/^## Implementation plan$/gm) ?? [];
    expect(headingMatches).toHaveLength(1);
  });

  it("7.4 renders plan summary and per-item annotations above the test-files block", async () => {
    const promptUrl = new URL("../../../src/agents/coder/prompt.md", import.meta.url);
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const template = await readFile(fileURLToPath(promptUrl), "utf8");

    const out = renderPrompt(template, TICKET, SPEC_OUTPUT, "/workspace");

    expect(out).toContain(validImplementationPlan.summary);
    expect(out).toContain("(test-covered)");
    expect(out).toContain("(plan-only)");
    const planIdx = out.indexOf("## Implementation plan");
    const testsIdx = out.indexOf("## Failing tests committed by the spec agent");
    expect(planIdx).toBeGreaterThan(-1);
    expect(testsIdx).toBeGreaterThan(planIdx);
  });
});

describe("buildStuckBody", () => {
  it("formats reason, dependency, and questions checklist", () => {
    const body = buildStuckBody({
      reason: "Need axios.",
      dependency: "axios",
      questions: ["Version?", "Why?"],
    });
    expect(body).toContain("Need axios.");
    expect(body).toContain("**Missing dependency:** axios");
    expect(body).toContain("- [ ] Version?");
    expect(body).toContain("- [ ] Why?");
  });

  it("omits dependency line when not provided", () => {
    const body = buildStuckBody({ reason: "Design ambiguity.", questions: ["A?"] });
    expect(body).not.toContain("**Missing dependency:**");
    expect(body).toContain("- [ ] A?");
  });
});

describe("buildWorkflowDeepLink", () => {
  it("encodes namespace and workflowId, strips trailing slash", () => {
    expect(
      buildWorkflowDeepLink("http://localhost:8233/", "default", "ticket-issue_1"),
    ).toBe("http://localhost:8233/namespaces/default/workflows/ticket-issue_1");
  });
});

describe("parseShortStat", () => {
  it("parses files / insertions / deletions", () => {
    expect(parseShortStat(" 2 files changed, 10 insertions(+), 1 deletion(-)")).toEqual({
      filesChanged: 2,
      insertions: 10,
      deletions: 1,
    });
  });
  it("handles single file, no deletions", () => {
    expect(parseShortStat(" 1 file changed, 5 insertions(+)")).toEqual({
      filesChanged: 1,
      insertions: 5,
      deletions: 0,
    });
  });
  it("returns zeros on empty string", () => {
    expect(parseShortStat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe("parseTestRunSummary", () => {
  it("parses vitest output", () => {
    const result = parseTestRunSummary("Tests  3 passed (3)\n", "", 1234);
    expect(result).toEqual({ total: 3, passed: 3, failed: 0, durationMs: 1234 });
  });
  it("parses jest output", () => {
    const result = parseTestRunSummary("Tests:       5 passed, 5 total\n", "", 50);
    expect(result).toEqual({ total: 5, passed: 5, failed: 0, durationMs: 50 });
  });
  it("falls back to 1/1 when output is unrecognized", () => {
    const result = parseTestRunSummary("nothing here", "", 10);
    expect(result).toEqual({ total: 1, passed: 1, failed: 0, durationMs: 10 });
  });
});
