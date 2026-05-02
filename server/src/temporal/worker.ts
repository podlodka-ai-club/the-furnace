import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import type {
  CoderPhaseOutput,
  ReviewResult,
  ReviewerInput,
  SpecPhaseOutput,
} from "../agents/contracts/index.js";
import type { ResolvedTicket } from "../linear/types.js";
import * as helloActivities from "./activities/hello.js";
import * as linearActivities from "./activities/linear.js";
import * as phaseActivities from "./activities/phases.js";
import * as workerLauncherActivities from "./activities/worker-launcher.js";
import type { SpecPhaseInput } from "./activities/phases.js";
import type { SyncLinearTicketStateInput } from "./activities/linear.js";
import type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
} from "./activities/worker-launcher.js";
import {
  CLAUDE_ACTIVITY_CONCURRENCY,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
} from "./config.js";
import { createTemporalClient } from "./client.js";
import { ensureLinearPollerSchedule } from "./schedule.js";
import { assertWorkerAuthAvailable } from "../worker-launcher.js";

export interface TemporalWorkerActivities {
  helloActivity(name: string): Promise<string>;
  listAgentReadyTicketsActivity(): Promise<ResolvedTicket[]>;
  syncLinearTicketStateActivity(input: SyncLinearTicketStateInput): Promise<void>;
  // Phase activities are NOT registered on the orchestrator queue in production;
  // they run inside ephemeral per-repo containers and are dispatched on the
  // per-repo task queue (`repo-${slug}-worker`). They remain part of this type
  // so tests can opt into orchestrator-side execution via `injectPhaseActivities`.
  runSpecPhase(input: SpecPhaseInput): Promise<SpecPhaseOutput>;
  runCoderPhase(input: SpecPhaseOutput): Promise<CoderPhaseOutput>;
  runReviewPhase(input: ReviewerInput): Promise<ReviewResult>;
  launchWorkerContainer(input: LaunchWorkerContainerInput): Promise<LaunchWorkerContainerResult>;
  validateRepoSlug(input: { slug: string }): Promise<void>;
}

const orchestratorOnlyActivities = {
  ...helloActivities,
  ...linearActivities,
  ...workerLauncherActivities,
};

const defaultActivities: TemporalWorkerActivities = {
  ...orchestratorOnlyActivities,
  // Phase activities are present in defaults only as a fallback for environments
  // where containers aren't launching (e.g. local dev without the worker bundle).
  // Production deployments should set `injectPhaseActivities: false` so phase
  // tasks queue on `repo-${slug}-worker` and are claimed by a container worker.
  ...phaseActivities,
};

export interface CreateTemporalWorkerOptions {
  activities?: Partial<TemporalWorkerActivities>;
  workflowsPath?: string;
  // When false (production default once the orchestrator runs without phase
  // fallback), the orchestrator worker must NOT register phase activities; this
  // is the wiring described in `openspec/specs/orchestration-substrate/spec.md`.
  injectPhaseActivities?: boolean;
  taskQueue?: string;
}

export async function createTemporalWorker(options: CreateTemporalWorkerOptions = {}): Promise<Worker> {
  try {
    const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    const activities = resolveActivities(options);
    return Worker.create({
      activities,
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: options.taskQueue ?? TEMPORAL_TASK_QUEUE,
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

function resolveActivities(options: CreateTemporalWorkerOptions): Record<string, unknown> {
  // injectPhaseActivities is opt-out: defaults to true to keep local dev and
  // existing tests working. Production deployments set it to false so phase
  // tasks must be claimed by a container worker on the per-repo queue.
  const base = options.injectPhaseActivities === false
    ? { ...orchestratorOnlyActivities }
    : { ...defaultActivities };
  return options.activities ? { ...base, ...options.activities } : base;
}

export interface CreatePerRepoWorkerOptions {
  taskQueue: string;
  activities?: Pick<TemporalWorkerActivities, "runSpecPhase" | "runCoderPhase" | "runReviewPhase">;
}

// Creates an activity-only worker bound to the given per-repo task queue.
// Used by integration tests that need a worker to claim phase activities
// without spawning a real container — see container-lifecycle.test.ts.
export async function createPerRepoWorker(options: CreatePerRepoWorkerOptions): Promise<Worker> {
  try {
    const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    return Worker.create({
      activities: options.activities ?? phaseActivities,
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: options.taskQueue,
      maxConcurrentActivityTaskExecutions: 1,
    });
  } catch (error) {
    throw new Error(
      `Unable to start per-repo worker for ${options.taskQueue} on ${TEMPORAL_ADDRESS}`,
      { cause: error },
    );
  }
}

export async function runTemporalWorker(): Promise<void> {
  await assertWorkerAuthAvailable();

  const client = await createTemporalClient();
  const scheduleOutcome = await ensureLinearPollerSchedule(client.schedule);
  console.log(`Linear poller schedule ${scheduleOutcome} (${TEMPORAL_TASK_QUEUE})`);

  const worker = await createTemporalWorker();
  await worker.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTemporalWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
