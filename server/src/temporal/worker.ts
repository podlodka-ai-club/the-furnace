import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import type {
  CoderPhaseOutput,
  ReviewResult,
  ReviewerInput,
  SpecPhaseOutput,
} from "../agents/contracts/index.js";
import type { Ticket } from "../linear/types.js";
import * as helloActivities from "./activities/hello.js";
import * as linearActivities from "./activities/linear.js";
import * as phaseActivities from "./activities/phases.js";
import * as workflowRunActivities from "./activities/workflow-runs.js";
import type { SpecPhaseInput } from "./activities/phases.js";
import type { SyncLinearTicketStateInput } from "./activities/linear.js";
import type {
  PersistWorkflowRunStartInput,
  PersistWorkflowRunTransitionInput,
} from "./activities/workflow-runs.js";
import {
  CLAUDE_ACTIVITY_CONCURRENCY,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
} from "./config.js";

export interface TemporalWorkerActivities {
  helloActivity(name: string): Promise<string>;
  listAgentReadyTicketsActivity(): Promise<Ticket[]>;
  syncLinearTicketStateActivity(input: SyncLinearTicketStateInput): Promise<void>;
  runSpecPhase(input: SpecPhaseInput): Promise<SpecPhaseOutput>;
  runCoderPhase(input: SpecPhaseOutput): Promise<CoderPhaseOutput>;
  runReviewPhase(input: ReviewerInput): Promise<ReviewResult>;
  persistWorkflowRunStart(input: PersistWorkflowRunStartInput): Promise<void>;
  persistWorkflowRunTransition(input: PersistWorkflowRunTransitionInput): Promise<void>;
}

const defaultActivities: TemporalWorkerActivities = {
  ...helloActivities,
  ...linearActivities,
  ...phaseActivities,
  ...workflowRunActivities,
};

export interface CreateTemporalWorkerOptions {
  activities?: TemporalWorkerActivities;
  workflowsPath?: string;
}

export async function createTemporalWorker(options: CreateTemporalWorkerOptions = {}): Promise<Worker> {
  try {
    const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    return Worker.create({
      activities: options.activities ?? defaultActivities,
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TEMPORAL_TASK_QUEUE,
      workflowsPath:
        options.workflowsPath ?? fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
      maxConcurrentActivityTaskExecutions: CLAUDE_ACTIVITY_CONCURRENCY,
    });
  } catch (error) {
    throw new Error(
      `Unable to start Temporal worker for ${TEMPORAL_ADDRESS}. Ensure 'docker compose up -d temporal temporal-ui' is running and retry.`,
      { cause: error },
    );
  }
}

export async function runTemporalWorker(): Promise<void> {
  const worker = await createTemporalWorker();
  await worker.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTemporalWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
