import { randomUUID } from "node:crypto";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_ACTIVITY_CONCURRENCY,
  TEMPORAL_TASK_QUEUE,
} from "../../src/temporal/config.js";
import { createTemporalClient } from "../../src/temporal/client.js";
import { createTemporalWorker } from "../../src/temporal/worker.js";
import { HELLO_WORKFLOW_NAME } from "../../src/temporal/workflows/hello.js";

describe("Temporal hello smoke workflow", () => {
  it("uses a bounded worker activity concurrency", () => {
    expect(CLAUDE_ACTIVITY_CONCURRENCY).toBeGreaterThan(0);
    expect(CLAUDE_ACTIVITY_CONCURRENCY).toBeLessThanOrEqual(4);
  });

  it("executes client -> workflow -> activity round-trip", async () => {
    await expect(assertTemporalPortReachable()).resolves.toBeUndefined();
    const client = await createTemporalClient();
    const worker = await createTemporalWorker();
    await worker.runUntil(async () => {
      const runId = randomUUID();
      const workflowId = `hello-smoke-${runId}`;
      const handle = await client.workflow.start(HELLO_WORKFLOW_NAME, {
        args: ["Temporal"],
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowId,
      });

      await expect(handle.result()).resolves.toBe("hello, Temporal");
    });
  }, 30_000);
});

async function assertTemporalPortReachable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 7233 });

    socket.once("connect", () => {
      socket.end();
      resolve();
    });

    socket.once("error", () => {
      reject(
        new Error(
          "Temporal frontend is unreachable on localhost:7233. Start it with 'docker compose up -d temporal temporal-ui' and re-run tests.",
        ),
      );
    });

    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(
        new Error(
          "Temporal frontend connect timed out on localhost:7233. Start it with 'docker compose up -d temporal temporal-ui' and re-run tests.",
        ),
      );
    });
  });
}
