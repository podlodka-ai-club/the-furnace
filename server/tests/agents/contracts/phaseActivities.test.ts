import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  coderPhaseOutputSchema,
  reviewResultSchema,
  reviewerInputSchema,
  specPhaseOutputSchema,
} from "../../../src/agents/contracts/index.js";
import {
  runCoderPhase,
  runReviewPhase,
  runSpecPhase,
  specPhaseInputSchema,
} from "../../../src/temporal/activities/phases.js";
import type {
  SpecAgentClient,
  SpecAgentDecision,
  SpecAgentSession,
} from "../../../src/agents/spec/agent.js";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../src/agents/spec/repo-ops.js";
import type { LinearClientApi } from "../../../src/linear/types.js";

describe("phase activities contract boundaries", () => {
  it("returns spec phase output that passes schema validation", async () => {
    const input = specPhaseInputSchema.parse({
      ticket: {
        id: "ticket_1",
        identifier: "ENG-123",
        title: "Agent IO contracts",
        description: "Agent IO contracts spec",
      },
    });

    const repoPath = await mkdtemp(path.join(os.tmpdir(), "furnace-spec-contract-"));
    try {
      const decisions: SpecAgentDecision[] = [
        {
          type: "propose_failing_tests",
          input: {
            files: [
              {
                path: "tests/contract.test.ts",
                contents: "test('x', () => { throw new Error(); });\n",
                description: "covers contract",
              },
            ],
          },
        },
      ];
      let cursor = 0;
      const session: SpecAgentSession = {
        next: async () => decisions[cursor++],
        close: async () => {},
      };
      const agentClient: SpecAgentClient = {
        startSession: async () => session,
      };

      const ok = (stdout = ""): RunCommandResult => ({ exitCode: 0, stdout, stderr: "" });
      const fail = (): RunCommandResult => ({ exitCode: 1, stdout: "", stderr: "x" });
      const steps: Array<(c: string, a: string[]) => RunCommandResult | null> = [
        // npm test → exit 1 (real failure)
        (c, a) => (c === "npm" && a[0] === "test" ? fail() : null),
        // git symbolic-ref
        (c, a) => (c === "git" && a[0] === "symbolic-ref" ? ok("origin/main\n") : null),
        // git checkout -B
        (c, a) => (c === "git" && a[0] === "checkout" ? ok() : null),
        // git add
        (c, a) => (c === "git" && a[0] === "add" ? ok() : null),
        // git commit
        (c, a) => (c === "git" && a[0] === "commit" ? ok() : null),
        // git rev-parse HEAD
        (c, a) => (c === "git" && a[0] === "rev-parse" ? ok(`${"a".repeat(40)}\n`) : null),
        // git push
        (c, a) => (c === "git" && a[0] === "push" ? ok() : null),
      ];
      let stepIdx = 0;
      const run: RunCommand = async (command, args) => {
        while (stepIdx < steps.length) {
          const result = steps[stepIdx](command, args);
          stepIdx += 1;
          if (result) return result;
        }
        throw new Error(`unexpected runCommand: ${command} ${args.join(" ")}`);
      };

      const linearClient: LinearClientApi = {
        listAgentReadyTickets: async () => [],
        createSubTicket: async () => {
          throw new Error("should not be called");
        },
        postComment: async () => ({ id: "x" }),
        updateIssueState: async () => {},
      };

      const output = await runSpecPhase(input, {
        agentClient,
        runCommand: run,
        linearClient,
        loadPrompt: async () => "system prompt",
        fetchTicket: async () => ({ title: "Agent IO contracts", description: "desc" }),
        resolveRepoPath: () => repoPath,
        resolveWorkflowMeta: () => ({
          workflowId: "ticket-test",
          namespace: "default",
          attempt: 1,
        }),
        resolveWebBase: () => "http://localhost:8233",
      });
      expect(specPhaseOutputSchema.parse(output)).toEqual(output);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("returns coder phase output that passes schema validation", async () => {
    const specOutput = specPhaseOutputSchema.parse({
      featureBranch: "agent/spec-eng-123",
      testCommits: [
        {
          sha: "a".repeat(40),
          path: "server/tests/integration/sample.test.ts",
          description: "Add failing acceptance criteria tests",
        },
      ],
    });

    const output = await runCoderPhase(specOutput);
    expect(coderPhaseOutputSchema.parse(output)).toEqual(output);
  });

  it("returns review result that passes schema validation", async () => {
    const reviewerInput = reviewerInputSchema.parse({
      ticket: {
        id: "ticket_1",
        identifier: "ENG-123",
        title: "Agent IO contracts",
        description: "Agent IO contracts spec",
      },
      featureBranch: "agent/spec-eng-123",
      finalCommitSha: "b".repeat(40),
      diffStat: { filesChanged: 2, insertions: 10, deletions: 1 },
      testRunSummary: { total: 2, passed: 2, failed: 0, durationMs: 1200 },
    });

    const output = await runReviewPhase(reviewerInput);
    expect(reviewResultSchema.parse(output)).toEqual(output);
  });
});
