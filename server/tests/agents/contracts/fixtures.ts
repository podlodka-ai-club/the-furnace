import type { ImplementationPlan } from "../../../src/agents/contracts/index.js";

export const validSubTicketRef = {
  id: "sub_123",
  identifier: "ENG-123",
  title: "Clarify acceptance criteria",
};

export const validDiffStat = {
  filesChanged: 3,
  insertions: 42,
  deletions: 8,
};

export const validTestRunSummary = {
  total: 12,
  passed: 12,
  failed: 0,
  durationMs: 1834,
};

export const validImplementationPlan: ImplementationPlan = {
  summary: "Add a typed export endpoint and a frontend export button that POSTs to it.",
  workItems: [
    {
      area: "backend",
      description: "Add POST /export handler that streams a CSV of the user's records.",
      coveredByTests: true,
    },
    {
      area: "frontend",
      description: "Add an Export button on the dashboard that triggers the new endpoint.",
      coveredByTests: false,
    },
  ],
};

export function makeImplementationPlanFixture(
  overrides: Partial<ImplementationPlan> = {},
): ImplementationPlan {
  return {
    ...validImplementationPlan,
    ...overrides,
    workItems: overrides.workItems ?? [...validImplementationPlan.workItems],
  };
}

export const validSpecPhaseOutput = {
  featureBranch: "agent/spec-eng-123",
  testCommits: [
    {
      sha: "a".repeat(40),
      path: "server/tests/integration/sample.test.ts",
      description: "Add failing acceptance criteria tests",
    },
  ],
  implementationPlan: validImplementationPlan,
  acClarification: validSubTicketRef,
};

export const validCoderPhaseOutput = {
  featureBranch: "agent/spec-eng-123",
  finalCommitSha: "b".repeat(40),
  diffStat: validDiffStat,
  testRunSummary: validTestRunSummary,
  escalation: validSubTicketRef,
};

export const validReviewerInput = {
  ticket: {
    id: "ticket_1",
    identifier: "ENG-123",
    title: "Implement agent io contracts",
    description: "Implement the agent IO contract layer.",
  },
  featureBranch: validCoderPhaseOutput.featureBranch,
  finalCommitSha: validCoderPhaseOutput.finalCommitSha,
  diffStat: validCoderPhaseOutput.diffStat,
  testRunSummary: validCoderPhaseOutput.testRunSummary,
  prNumber: 17,
  round: 0,
};

export const validReviewResult = {
  verdict: "approve",
  reasoning: "All tests are green and contract coverage is complete.",
  findings: [
    {
      path: "server/src/agents/contracts/index.ts",
      line: 12,
      severity: "advisory" as const,
      message: "Contracts are validated at activity boundaries.",
    },
  ],
};

export const invalidSubTicketRef = {
  id: "",
  identifier: "",
  title: "",
};

export const invalidDiffStat = {
  filesChanged: -1,
  insertions: 3,
  deletions: 1,
};

export const invalidTestRunSummary = {
  total: 2,
  passed: 1,
  failed: 2,
  durationMs: -1,
};

export const invalidSpecPhaseOutput = {
  ...validSpecPhaseOutput,
  testCommits: [
    {
      sha: "short-sha",
      path: "",
      description: "",
    },
  ],
};

export const specPhaseOutputMissingPlan = (() => {
  const { implementationPlan: _ignored, ...rest } = validSpecPhaseOutput;
  return rest;
})();

export const specPhaseOutputInvalidArea = {
  ...validSpecPhaseOutput,
  implementationPlan: {
    ...validImplementationPlan,
    workItems: [
      {
        area: "infra",
        description: "Provision a new bucket",
        coveredByTests: false,
      },
    ],
  },
};

export const invalidCoderPhaseOutput = {
  ...validCoderPhaseOutput,
  finalCommitSha: "not-a-sha",
};

export const invalidReviewerInput = {
  ...validReviewerInput,
  ticket: {
    id: "",
    identifier: "",
    title: "",
    description: "",
  },
};

export const invalidReviewResult = {
  verdict: "maybe",
  reasoning: "",
  findings: [{ path: "", severity: "blocking", message: "" }],
};
