import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import {
  runSpecPhase,
  SPEC_CORRECTION_BUDGET,
  SPEC_FAILURE_TYPES,
  type FetchTicket,
  type RunSpecPhaseDeps,
} from "../../../src/agents/spec/activity.js";
import type {
  SpecAgentClient,
  SpecAgentDecision,
  SpecAgentRunOptions,
  SpecAgentSession,
} from "../../../src/agents/spec/agent.js";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../src/agents/spec/repo-ops.js";
import type { LinearClientApi, CreatedSubTicket } from "../../../src/linear/types.js";
import type { ReviewerTicket } from "../../../src/agents/contracts/index.js";

const TICKET: ReviewerTicket = {
  id: "issue_1",
  identifier: "ENG-42",
  title: "Implement feature X",
};

interface StubSessionOptions {
  decisions: SpecAgentDecision[];
}

function makeStubSession({ decisions }: StubSessionOptions): {
  session: SpecAgentSession;
  calls: { correctiveMessage?: string }[];
} {
  const calls: { correctiveMessage?: string }[] = [];
  let index = 0;
  const session: SpecAgentSession = {
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

function makeStubAgentClient(
  decisions: SpecAgentDecision[],
): { client: SpecAgentClient; calls: { correctiveMessage?: string }[]; opts: SpecAgentRunOptions[] } {
  const opts: SpecAgentRunOptions[] = [];
  const { session, calls } = makeStubSession({ decisions });
  const client: SpecAgentClient = {
    startSession: async (options) => {
      opts.push(options);
      return session;
    },
  };
  return { client, calls, opts };
}

function makeFetchTicket(): FetchTicket {
  return async (id: string) => {
    if (id !== TICKET.id) return null;
    return { title: "Implement feature X", description: "User can do X." };
  };
}

interface ScriptedRunCommandStep {
  match: (command: string, args: string[]) => boolean;
  result: RunCommandResult;
}

function makeScriptedRunCommand(steps: ScriptedRunCommandStep[]): {
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

function fail(stderr = "fail"): RunCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}

const NOOP_LINEAR_CLIENT: LinearClientApi = {
  listAgentReadyTickets: async () => [],
  createSubTicket: async () => {
    throw new Error("createSubTicket should not be called on this path");
  },
  postComment: async () => ({ id: "x" }),
  updateIssueState: async () => {},
};

function makeBaseDeps(overrides: Partial<RunSpecPhaseDeps> = {}): RunSpecPhaseDeps {
  return {
    loadPrompt: async () => "system prompt for {{TICKET_IDENTIFIER}}",
    resolveWorkflowMeta: () => ({
      workflowId: "ticket-issue_1",
      namespace: "default",
      attempt: 1,
    }),
    fetchTicket: makeFetchTicket(),
    linearClient: NOOP_LINEAR_CLIENT,
    ...overrides,
  };
}

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), "furnace-spec-activity-"));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("runSpecPhase", () => {
  it("happy path: writes files, verifies failing test, branches, commits per file, pushes", async () => {
    const decisions: SpecAgentDecision[] = [
      {
        type: "propose_failing_tests",
        input: {
          files: [
            {
              path: "tests/feature-x.test.ts",
              contents: "test('x', () => { throw new Error('not yet'); });\n",
              description: "covers feature X",
            },
            {
              path: "tests/feature-x-edge.test.ts",
              contents: "test('edge', () => { throw new Error('not yet'); });\n",
              description: "covers feature X edges",
            },
          ],
        },
      },
    ];
    const { client, calls: agentCalls } = makeStubAgentClient(decisions);

    const { run } = makeScriptedRunCommand([
      // 1. resolveTestCommand reads package.json (NOT via runCommand) — skipped here.
      // 2. Test run (npm test ...): exit 1 = failed
      { match: (c, a) => c === "npm" && a[0] === "test", result: fail("AssertionError: not yet") },
      // 3. getDefaultBranch: try symbolic-ref
      {
        match: (c, a) => c === "git" && a[0] === "symbolic-ref",
        result: ok("origin/main\n"),
      },
      // 4. createFeatureBranch: git checkout -B
      {
        match: (c, a) => c === "git" && a[0] === "checkout",
        result: ok(),
      },
      // 5. commit file 1: add
      { match: (c, a) => c === "git" && a[0] === "add" && a.includes("tests/feature-x.test.ts"), result: ok() },
      // 6. commit file 1: commit
      { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
      // 7. commit file 1: rev-parse
      { match: (c, a) => c === "git" && a[0] === "rev-parse", result: ok(`${"a".repeat(40)}\n`) },
      // 8. commit file 2: add
      { match: (c, a) => c === "git" && a[0] === "add" && a.includes("tests/feature-x-edge.test.ts"), result: ok() },
      // 9. commit file 2: commit
      { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
      // 10. commit file 2: rev-parse
      { match: (c, a) => c === "git" && a[0] === "rev-parse", result: ok(`${"b".repeat(40)}\n`) },
      // 11. push
      { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
    ]);

    const output = await runSpecPhase(
      { ticket: TICKET },
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    expect(output.featureBranch).toBe("agent/spec-eng-42");
    expect(output.testCommits).toHaveLength(2);
    expect(output.testCommits[0]).toMatchObject({
      sha: "a".repeat(40),
      path: "tests/feature-x.test.ts",
      description: "covers feature X",
    });
    expect(output.testCommits[1]).toMatchObject({
      sha: "b".repeat(40),
      path: "tests/feature-x-edge.test.ts",
    });
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].correctiveMessage).toBeUndefined();
  });

  it("false-failing-test correction: nudges agent when test command exits 0", async () => {
    const decisions: SpecAgentDecision[] = [
      // First proposal "succeeds" (exit 0) → triggers false-failing nudge
      {
        type: "propose_failing_tests",
        input: {
          files: [
            {
              path: "tests/passes.test.ts",
              contents: "test('ok', () => { /* passes */ });\n",
              description: "noop test",
            },
          ],
        },
      },
      // Second proposal actually fails → activity proceeds to commit/push
      {
        type: "propose_failing_tests",
        input: {
          files: [
            {
              path: "tests/fails.test.ts",
              contents: "test('not yet', () => { throw new Error('x'); });\n",
              description: "real failing test",
            },
          ],
        },
      },
    ];
    const { client, calls: agentCalls } = makeStubAgentClient(decisions);

    const { run } = makeScriptedRunCommand([
      // First test run: exit 0 (false-failing)
      { match: (c, a) => c === "npm" && a[0] === "test", result: ok("all good") },
      // Second test run: exit 1 (real failure)
      { match: (c, a) => c === "npm" && a[0] === "test", result: fail("AssertionError") },
      { match: (c, a) => c === "git" && a[0] === "symbolic-ref", result: ok("origin/main\n") },
      { match: (c, a) => c === "git" && a[0] === "checkout", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "commit", result: ok() },
      { match: (c, a) => c === "git" && a[0] === "rev-parse", result: ok(`${"c".repeat(40)}\n`) },
      { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
    ]);

    const output = await runSpecPhase(
      { ticket: TICKET },
      makeBaseDeps({
        agentClient: client,
        runCommand: run,
        resolveRepoPath: () => repoPath,
      }),
    );

    expect(output.testCommits).toHaveLength(1);
    expect(output.testCommits[0].path).toBe("tests/fails.test.ts");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0].correctiveMessage).toBeUndefined();
    expect(agentCalls[1].correctiveMessage).toBeDefined();
    expect(agentCalls[1].correctiveMessage).toMatch(/did not fail/i);
    expect(agentCalls[1].correctiveMessage).toMatch(/tests\/passes\.test\.ts/);
  });

  it("prose-only correction loop: exhausts budget and throws toolBudgetExhausted", async () => {
    // SPEC_CORRECTION_BUDGET no_tool_call decisions, then one more — budget exhaustion
    // happens BEFORE the (budget+1)th nudge is attempted, so we only need budget+1
    // total decisions to trigger the throw.
    const decisions: SpecAgentDecision[] = Array.from(
      { length: SPEC_CORRECTION_BUDGET + 1 },
      () => ({ type: "no_tool_call" as const }),
    );
    const { client, calls: agentCalls } = makeStubAgentClient(decisions);

    // No runCommand calls expected on this path (no tool was ever called).
    const { run } = makeScriptedRunCommand([]);

    await expect(
      runSpecPhase(
        { ticket: TICKET },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          resolveRepoPath: () => repoPath,
        }),
      ),
    ).rejects.toMatchObject({
      type: SPEC_FAILURE_TYPES.toolBudgetExhausted,
    });

    // Budget exhausts after BUDGET corrections → BUDGET+1 next() calls in total.
    expect(agentCalls).toHaveLength(SPEC_CORRECTION_BUDGET + 1);
    // First call has no corrective message; subsequent calls do.
    expect(agentCalls[0].correctiveMessage).toBeUndefined();
    for (let i = 1; i < agentCalls.length; i++) {
      expect(agentCalls[i].correctiveMessage).toBeDefined();
    }
  });

  it("request_ac_clarification: opens sub-ticket and throws non-retryable AcClarificationRequested", async () => {
    const decisions: SpecAgentDecision[] = [
      {
        type: "request_ac_clarification",
        input: {
          reason: "AC §2 doesn't say what 'merge' means",
          questions: ["What does merge mean here?", "Is duplicate handling required?"],
        },
      },
    ];
    const { client } = makeStubAgentClient(decisions);

    const subTicket: CreatedSubTicket = {
      id: "issue_99",
      identifier: "ENG-99",
      title: "[ac-clarification] ENG-42 Implement feature X",
    };

    const linearCalls: { parentId: string; type: string; body: string; deepLink: string }[] = [];
    const linearClient: LinearClientApi = {
      listAgentReadyTickets: async () => [],
      createSubTicket: async (parentId, type, body, deepLink) => {
        linearCalls.push({ parentId, type, body, deepLink });
        return subTicket;
      },
      postComment: async () => ({ id: "x" }),
      updateIssueState: async () => {},
    };

    const { run } = makeScriptedRunCommand([]); // no shell calls expected

    let caught: unknown;
    try {
      await runSpecPhase(
        { ticket: TICKET },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          linearClient,
          resolveRepoPath: () => repoPath,
          resolveWebBase: () => "https://temporal.example.test",
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApplicationFailure);
    expect((caught as ApplicationFailure).type).toBe(SPEC_FAILURE_TYPES.acClarificationRequested);
    expect((caught as ApplicationFailure).nonRetryable).toBe(true);
    const details = (caught as ApplicationFailure).details ?? [];
    expect(details).toContainEqual({ subTicketRef: subTicket });

    expect(linearCalls).toHaveLength(1);
    expect(linearCalls[0].parentId).toBe(TICKET.id);
    expect(linearCalls[0].type).toBe("ac-clarification");
    expect(linearCalls[0].body).toMatch(/Why this is blocked/);
    expect(linearCalls[0].body).toMatch(/AC §2 doesn't say what 'merge' means/);
    expect(linearCalls[0].body).toMatch(/- \[ \] What does merge mean here\?/);
    expect(linearCalls[0].deepLink).toBe(
      "https://temporal.example.test/namespaces/default/workflows/ticket-issue_1",
    );
  });

  it("Linear outage on createSubTicket: throws retryable LinearSubTicketCreationFailed", async () => {
    const decisions: SpecAgentDecision[] = [
      {
        type: "request_ac_clarification",
        input: {
          reason: "blocked",
          questions: ["?"],
        },
      },
    ];
    const { client } = makeStubAgentClient(decisions);

    const linearClient: LinearClientApi = {
      listAgentReadyTickets: async () => [],
      createSubTicket: async () => {
        throw new Error("Linear API unavailable: 503");
      },
      postComment: async () => ({ id: "x" }),
      updateIssueState: async () => {},
    };

    const { run } = makeScriptedRunCommand([]);

    let caught: unknown;
    try {
      await runSpecPhase(
        { ticket: TICKET },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          linearClient,
          resolveRepoPath: () => repoPath,
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApplicationFailure);
    const failure = caught as ApplicationFailure;
    expect(failure.type).toBe("LinearSubTicketCreationFailed");
    expect(failure.nonRetryable).toBe(false);
    expect(failure.message).toMatch(/Linear sub-ticket creation failed/);
    expect(failure.message).toMatch(/503/);
  });

  it("ticket not found in DB: throws non-retryable SpecTicketNotFound", async () => {
    const { client } = makeStubAgentClient([]);
    const { run } = makeScriptedRunCommand([]);

    await expect(
      runSpecPhase(
        { ticket: TICKET },
        makeBaseDeps({
          agentClient: client,
          runCommand: run,
          fetchTicket: async () => null,
          resolveRepoPath: () => repoPath,
        }),
      ),
    ).rejects.toMatchObject({
      type: SPEC_FAILURE_TYPES.ticketNotFound,
      nonRetryable: true,
    });
  });
});
