// Test entry point used by container-lifecycle.test.ts. Mirrors the production
// worker-entry.ts but registers slow phase activities that yield to
// cancellation, so SIGTERM scenarios are observable.
//
// Behavior is selected via env vars set by the integration test:
//   WORKER_TEST_BEHAVIOR=block  -> spec phase blocks on Context.sleep until cancelled
//   WORKER_TEST_BEHAVIOR=fast   -> spec phase returns immediately
// The spec output schema is satisfied either way so workflow retries can
// progress to completion.

import { Context } from "@temporalio/activity";
import {
  type ContainerWorkerEnv,
  MissingWorkerEnvError,
  readContainerWorkerEnv,
} from "../../../src/worker-env.js";
import { runContainerWorker } from "../../../src/worker-entry.js";
import { validImplementationPlan } from "../../agents/contracts/fixtures.js";

interface TestSpecInput {
  ticket: { id: string; identifier: string; title: string; description: string };
}

async function slowSpecPhase(input: TestSpecInput): Promise<unknown> {
  const behavior = process.env.WORKER_TEST_BEHAVIOR ?? "fast";
  if (behavior === "block") {
    // Sleep is cancellation-aware: throws CancelledFailure when worker.shutdown() runs.
    await Context.current().sleep("60 seconds");
  }
  return {
    featureBranch: `agent/spec-${input.ticket.identifier.toLowerCase()}`,
    testCommits: [
      {
        sha: "a".repeat(40),
        path: "server/tests/integration/sample.test.ts",
        description: `Failing acceptance tests for ${input.ticket.identifier}`,
      },
    ],
    implementationPlan: validImplementationPlan,
  };
}

// Coder phase input shape evolved (now `{ ticket, specOutput }`); accept both
// shapes so this fixture works with the historical and current activity sigs.
async function fastCoderPhase(input: {
  ticket?: unknown;
  specOutput?: { featureBranch?: string };
  featureBranch?: string;
}): Promise<unknown> {
  const featureBranch =
    input.specOutput?.featureBranch ?? input.featureBranch ?? "agent/spec-unknown";
  return {
    featureBranch,
    finalCommitSha: "c".repeat(40),
    diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
    testRunSummary: { total: 1, passed: 1, failed: 0, durationMs: 1 },
  };
}

async function fastReviewPhase(_input: unknown): Promise<unknown> {
  return { verdict: "approve", reasoning: "ok", findings: [] };
}

async function main(): Promise<void> {
  let env: ContainerWorkerEnv;
  try {
    env = readContainerWorkerEnv();
  } catch (error) {
    if (error instanceof MissingWorkerEnvError) {
      console.error(`[test-worker] ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  const result = await runContainerWorker(env, {
    activities: {
      runSpecPhase: slowSpecPhase as (...args: unknown[]) => unknown,
      runCoderPhase: fastCoderPhase as (...args: unknown[]) => unknown,
      runReviewPhase: fastReviewPhase as (...args: unknown[]) => unknown,
    },
  });

  if (result.failure) {
    console.error(
      `[test-worker] activity failed: ${result.failure instanceof Error ? result.failure.message : String(result.failure)}`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
