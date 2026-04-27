import { NativeConnection, Worker } from "@temporalio/worker";
import * as phaseActivities from "./temporal/activities/phases.js";
import { taskQueueForRepo } from "./temporal/repo-slug.js";
import {
  type ContainerWorkerEnv,
  MissingWorkerEnvError,
  readContainerWorkerEnv,
} from "./worker-env.js";

type ActivityFn = (...args: unknown[]) => unknown | Promise<unknown>;
type ActivityRegistry = Record<string, ActivityFn>;

export interface WorkerHandle {
  shutdown(): Promise<void> | void;
}

export interface SingleTaskState {
  failure: unknown;
}

export function singleTaskActivity<F extends ActivityFn>(
  impl: F,
  getWorker: () => WorkerHandle | undefined,
  state: SingleTaskState,
): F {
  const wrapped = async function singleTaskWrapper(this: unknown, ...args: Parameters<F>): Promise<unknown> {
    try {
      return await impl.apply(this, args as unknown[]);
    } catch (error) {
      state.failure = error;
      throw error;
    } finally {
      // Schedule shutdown on the next tick so Temporal ships the activity result
      // before the worker stops accepting tasks. maxConcurrentActivityTaskExecutions=1
      // prevents a second task from being claimed during the shutdown window.
      setImmediate(() => {
        const worker = getWorker();
        if (worker) {
          void Promise.resolve(worker.shutdown()).catch(() => {});
        }
      });
    }
  };
  return wrapped as unknown as F;
}

function buildActivities(
  source: ActivityRegistry,
  getWorker: () => WorkerHandle | undefined,
  state: SingleTaskState,
): ActivityRegistry {
  const registry: ActivityRegistry = {};
  for (const [name, impl] of Object.entries(source)) {
    if (typeof impl !== "function") {
      continue;
    }
    registry[name] = singleTaskActivity(impl as ActivityFn, getWorker, state);
  }
  return registry;
}

export interface RunContainerWorkerOptions {
  // Activity overrides for tests; defaults to the real phase activities.
  // Tests use this to inject slow / cancellation-observing phase bodies.
  activities?: ActivityRegistry;
}

export interface RunContainerWorkerResult {
  failure: unknown;
}

export async function runContainerWorker(
  env: ContainerWorkerEnv,
  options: RunContainerWorkerOptions = {},
): Promise<RunContainerWorkerResult> {
  console.log(
    `[container-worker] starting repo=${env.repo} languages=${env.languages.join(",") || "<none>"} tools=${env.tools.join(",") || "<none>"} attempt=${env.attemptId ?? "<none>"}`,
  );

  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: env.temporal.address });
  } catch (error) {
    throw new Error(
      `[container-worker] unable to connect to Temporal at ${env.temporal.address}`,
      { cause: error },
    );
  }

  const queue = taskQueueForRepo(env.repo);
  let worker: Worker | undefined;
  const state: SingleTaskState = { failure: undefined };
  const source = (options.activities ?? phaseActivities) as ActivityRegistry;
  const activities = buildActivities(source, () => worker, state);

  try {
    worker = await Worker.create({
      activities,
      connection,
      namespace: env.temporal.namespace,
      taskQueue: queue,
      maxConcurrentActivityTaskExecutions: 1,
    });
  } catch (error) {
    await connection.close().catch(() => {});
    throw new Error(
      `[container-worker] unable to create Temporal worker for queue ${queue}`,
      { cause: error },
    );
  }

  const onSigterm = (): void => {
    console.log("[container-worker] received SIGTERM, shutting down");
    void Promise.resolve(worker?.shutdown()).catch(() => {});
  };
  const onSigint = (): void => {
    console.log("[container-worker] received SIGINT, shutting down");
    void Promise.resolve(worker?.shutdown()).catch(() => {});
  };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    await worker.run();
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  }

  return { failure: state.failure };
}

export async function main(): Promise<void> {
  let env: ContainerWorkerEnv;
  try {
    env = readContainerWorkerEnv();
  } catch (error) {
    if (error instanceof MissingWorkerEnvError) {
      console.error(`[container-worker] ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  let result: RunContainerWorkerResult;
  try {
    result = await runContainerWorker(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.cause) {
      console.error(error.cause);
    }
    process.exitCode = 1;
    return;
  }

  if (result.failure) {
    const message = result.failure instanceof Error ? result.failure.message : String(result.failure);
    console.error(`[container-worker] activity failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
