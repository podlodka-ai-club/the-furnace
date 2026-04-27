import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { taskQueueForRepo } from "./temporal/repo-slug.js";

export interface LaunchWorkerContainerInput {
  ticketId: string;
  phase: "spec" | "coder" | "review";
  attemptId: string;
  repoSlug: string;
}

export interface LaunchWorkerContainerResult {
  containerId: string;
  queue: string;
}

interface LauncherEnv {
  temporalAddress: string;
  // Address the spawned container uses to reach Temporal. Often differs from
  // the orchestrator's address: on macOS Docker Desktop the host's
  // `localhost:7233` is reachable from inside a container as
  // `host.docker.internal:7233`. Defaults to `temporalAddress` when unset.
  containerTemporalAddress: string;
  temporalNamespace: string;
  workerBundleDir: string;
  claudeCredsDir: string;
  buildDir: string;
}

interface ManifestRead {
  imageRef: string;
}

export interface LaunchWorkerContainerOptions {
  env?: NodeJS.ProcessEnv;
  // Indirection points exist for the integration test, which stubs `runDocker`
  // to spawn the worker entrypoint as a child process instead of running docker.
  runDocker?: (args: string[]) => Promise<{ containerId: string }>;
  loadManifest?: (slug: string, buildDir: string) => Promise<ManifestRead>;
}

export async function launchWorkerContainer(
  input: LaunchWorkerContainerInput,
  options: LaunchWorkerContainerOptions = {},
): Promise<LaunchWorkerContainerResult> {
  const env = readLauncherEnv(options.env ?? process.env);
  const manifest = await (options.loadManifest ?? loadManifest)(input.repoSlug, env.buildDir);
  const queue = taskQueueForRepo(input.repoSlug);

  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-d",
    "--env",
    `WORKER_REPO=${input.repoSlug}`,
    "--env",
    `WORKER_ATTEMPT_ID=${input.attemptId}`,
    "--env",
    `TEMPORAL_ADDRESS=${env.containerTemporalAddress}`,
    "--env",
    `TEMPORAL_NAMESPACE=${env.temporalNamespace}`,
    "--env",
    "WORKER_LANGUAGES",
    "--env",
    "WORKER_TOOLS",
    "--mount",
    `type=bind,source=${env.claudeCredsDir},target=/root/.claude,readonly`,
    "--mount",
    `type=bind,source=${env.workerBundleDir},target=/opt/furnace,readonly`,
    manifest.imageRef,
    "node",
    "/opt/furnace/worker-entry.js",
  ];

  const docker = options.runDocker ?? defaultRunDocker;
  const { containerId } = await docker(dockerArgs);
  return { containerId, queue };
}

function readLauncherEnv(env: NodeJS.ProcessEnv): LauncherEnv {
  const temporalAddress = env.TEMPORAL_ADDRESS ?? "localhost:7233";
  return {
    temporalAddress,
    containerTemporalAddress: env.CONTAINER_TEMPORAL_ADDRESS ?? temporalAddress,
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? "default",
    workerBundleDir: env.WORKER_BUNDLE_DIR ?? path.resolve(process.cwd(), "dist", "worker"),
    claudeCredsDir: env.CLAUDE_CREDS_DIR ?? path.join(os.homedir(), ".claude"),
    buildDir: env.BUILD_DIR ?? path.resolve(process.cwd(), "build"),
  };
}

async function loadManifest(slug: string, buildDir: string): Promise<ManifestRead> {
  // Prefer manifest.local.json when present (written by the local devcontainer
  // E2E) so dev runs use the localhost registry image without colliding with
  // the CI-committed manifest.json. Production hosts only ever have
  // manifest.json.
  const localPath = path.join(buildDir, slug, "manifest.local.json");
  const ciPath = path.join(buildDir, slug, "manifest.json");
  let manifestPath = localPath;
  let raw: string;
  try {
    raw = await readFile(localPath, "utf8");
  } catch {
    manifestPath = ciPath;
    raw = await readFile(ciPath, "utf8");
  }
  const parsed = JSON.parse(raw) as { imageRef?: unknown };
  if (typeof parsed.imageRef !== "string" || parsed.imageRef.length === 0) {
    throw new Error(`Manifest at ${manifestPath} is missing 'imageRef'`);
  }
  return { imageRef: parsed.imageRef };
}

async function defaultRunDocker(args: string[]): Promise<{ containerId: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `docker ${args.join(" ")} exited with code ${code ?? "<null>"}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      const containerId = stdout.trim();
      if (!containerId) {
        reject(new Error("docker run -d returned empty container id"));
        return;
      }
      resolve({ containerId });
    });
  });
}
