import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Connection, WorkflowClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as helloActivities from "../src/temporal/activities/hello.js";
import * as linearActivities from "../src/temporal/activities/linear.js";
import * as workflowRunActivities from "../src/temporal/activities/workflow-runs.js";
import {
  launchWorkerContainer as launchWorkerContainerImpl,
  type LaunchWorkerContainerInput,
  type LaunchWorkerContainerResult,
} from "../src/worker-launcher.js";
import {
  buildPerTicketWorkflowId,
  PER_TICKET_WORKFLOW_NAME,
  type PerTicketWorkflowInput,
} from "../src/temporal/workflows/per-ticket.js";

// Manual / pre-merge end-to-end test for `container-as-worker`. Boots a temporary
// orchestrator worker against a local Temporal, drives the per-ticket workflow
// against the real Docker daemon (each phase launches a real container that
// claims one phase activity and exits), and asserts every container exited 0.
//
// Prereqs:
//   - Local Temporal running (`docker compose up -d temporal temporal-ui`).
//   - Worker bundle built via `npm run build:worker` (the script will rebuild
//     it unless --skip-build is passed).
//   - The demo per-repo image already built (`build/<slug>/manifest.json`
//     exists). Build it via `npm run test:devcontainer:e2e` first if needed.
//
// On macOS / Windows Docker Desktop, set `CONTAINER_TEMPORAL_ADDRESS` to
// `host.docker.internal:7233` (the default of `localhost:7233` is reachable
// only from the host).

interface CliOptions {
  repoSlug: string;
  skipBuild: boolean;
}

const DEFAULT_REPO_SLUG = "microsoft-vscode-remote-try-node";

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const serverDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const repoRoot = path.resolve(serverDir, "..");
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? "default";

  // The launcher resolves BUILD_DIR / WORKER_BUNDLE_DIR from process.env, falling
  // back to `<cwd>/build` and `<cwd>/dist/worker`. When this script is invoked
  // via `npm run --prefix server`, cwd is `server/` — point them at repo-root
  // instead so the launcher finds the artifacts produced by `build:worker` /
  // `test:devcontainer:e2e`.
  process.env.BUILD_DIR = process.env.BUILD_DIR ?? path.join(repoRoot, "build");
  process.env.WORKER_BUNDLE_DIR =
    process.env.WORKER_BUNDLE_DIR ?? path.join(repoRoot, "dist", "worker");

  await assertManifestExists(repoRoot, options.repoSlug);

  if (!options.skipBuild) {
    console.log("[e2e] building worker bundle (npm run build:worker)");
    await runProcess("npm", ["run", "build:worker"], { cwd: repoRoot });
  }

  // Containers run with `--rm`, so `docker wait` only works while the container
  // still exists. Start the wait immediately after launch and remember the
  // promise — by the time the workflow finishes, each promise has captured the
  // exit code (or rejected), even though the container itself is gone.
  const tracked: { containerId: string; phase: string; exit: Promise<number> }[] = [];
  const orchestratorActivities = {
    ...helloActivities,
    ...linearActivities,
    ...workflowRunActivities,
    syncLinearTicketStateActivity: async () => {},
    listAgentReadyTicketsActivity: async () => [],
    persistWorkflowRunStart: async () => {},
    persistWorkflowRunTransition: async () => {},
    validateRepoSlug: async ({ slug }: { slug: string }): Promise<void> => {
      if (slug !== options.repoSlug) {
        throw new Error(`E2E expected slug '${options.repoSlug}', got '${slug}'`);
      }
    },
    launchWorkerContainer: async (
      input: LaunchWorkerContainerInput,
    ): Promise<LaunchWorkerContainerResult> => {
      console.log(`[e2e] launching container for phase=${input.phase} attemptId=${input.attemptId}`);
      const result = await launchWorkerContainerImpl(input);
      tracked.push({
        containerId: result.containerId,
        phase: input.phase,
        exit: dockerWait(result.containerId),
      });
      return result;
    },
  };

  // Unique queue per run isolates this e2e from any residual workflow tasks
  // (e.g. leftover from prior aborted integration runs) on the default queue.
  const e2eTaskQueue = `the-furnace-e2e-${randomUUID()}`;

  const connection = await NativeConnection.connect({ address: temporalAddress });
  const orchestratorWorker = await Worker.create({
    connection,
    namespace: temporalNamespace,
    taskQueue: e2eTaskQueue,
    workflowsPath: path.resolve(serverDir, "src/temporal/workflows/index.ts"),
    activities: orchestratorActivities,
    maxConcurrentActivityTaskExecutions: 4,
  });

  const clientConnection = await Connection.connect({ address: temporalAddress });
  const client = new WorkflowClient({ connection: clientConnection, namespace: temporalNamespace });

  const ticketId = `e2e-${randomUUID()}`;
  console.log(`[e2e] starting workflow ${buildPerTicketWorkflowId(ticketId)} on queue ${e2eTaskQueue}`);

  await orchestratorWorker.runUntil(async () => {
    const handle = await client.start(PER_TICKET_WORKFLOW_NAME, {
      args: [
        {
          ticket: { id: ticketId, identifier: "ENG-E2E", title: "container-as-worker e2e" },
          targetRepoSlug: options.repoSlug,
        } satisfies PerTicketWorkflowInput,
      ],
      taskQueue: e2eTaskQueue,
      workflowId: buildPerTicketWorkflowId(ticketId),
    });

    const result = await handle.result();
    console.log(`[e2e] workflow result: ${JSON.stringify(result)}`);
    if (result.status !== "succeeded") {
      throw new Error(`Expected status 'succeeded', got '${result.status}'`);
    }
  });

  await clientConnection.close();
  await connection.close();

  console.log(`[e2e] verifying ${tracked.length} container exit codes`);
  for (const t of tracked) {
    const exitCode = await t.exit;
    if (exitCode !== 0) {
      throw new Error(`Container ${t.containerId} (phase=${t.phase}) exited with code ${exitCode}, expected 0`);
    }
    console.log(`[e2e] container ${t.containerId.slice(0, 12)} (phase=${t.phase}) exited cleanly`);
  }

  console.log("[e2e] launch → claim → execute → exit verified for all phases");
}

async function assertManifestExists(repoRoot: string, slug: string): Promise<void> {
  const localPath = path.join(repoRoot, "build", slug, "manifest.local.json");
  const ciPath = path.join(repoRoot, "build", slug, "manifest.json");
  for (const candidate of [localPath, ciPath]) {
    try {
      await readFile(candidate, "utf8");
      return;
    } catch {
      // try next
    }
  }
  throw new Error(
    `Missing manifest at ${localPath} or ${ciPath}. Build the demo per-repo image first ` +
      `(npm run test:devcontainer:e2e -- --repo ${slug}).`,
  );
}

async function dockerWait(containerId: string): Promise<number> {
  const result = await runProcess("docker", ["wait", containerId], {
    cwd: process.cwd(),
    captureStdout: true,
  });
  const code = Number.parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(code)) {
    throw new Error(`docker wait ${containerId} returned non-numeric output: ${result.stdout}`);
  }
  return code;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "Usage:",
      "  npm run test:container-as-worker:e2e -- [--repo <slug>] [--skip-build]",
      "",
      `Defaults: --repo ${DEFAULT_REPO_SLUG}`,
      "",
      "Env:",
      "  TEMPORAL_ADDRESS              Temporal address for orchestrator (default localhost:7233)",
      "  CONTAINER_TEMPORAL_ADDRESS    Address passed to spawned containers (default same as TEMPORAL_ADDRESS;",
      "                                set to host.docker.internal:7233 on macOS/Windows Docker Desktop)",
    ].join("\n"));
    process.exit(0);
  }

  return {
    repoSlug: readArgValue(argv, "--repo") ?? DEFAULT_REPO_SLUG,
    skipBuild: argv.includes("--skip-build"),
  };
}

function readArgValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

interface RunProcessOptions {
  cwd: string;
  captureStdout?: boolean;
}

interface RunProcessResult {
  stdout: string;
}

async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  return await new Promise((resolve, reject) => {
    const stdio: ("inherit" | "pipe" | "ignore")[] = options.captureStdout
      ? ["ignore", "pipe", "inherit"]
      : ["ignore", "inherit", "inherit"];
    const child = spawn(command, args, { cwd: options.cwd, stdio });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
