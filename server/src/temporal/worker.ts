import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/hello.js";
import {
  CLAUDE_ACTIVITY_CONCURRENCY,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
} from "./config.js";

export async function createTemporalWorker(): Promise<Worker> {
  try {
    const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    return Worker.create({
      activities,
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TEMPORAL_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./workflows/hello.ts", import.meta.url)),
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
