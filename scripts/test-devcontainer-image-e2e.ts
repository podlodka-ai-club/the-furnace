import { spawn } from "node:child_process";
import path from "node:path";

import {
  buildRepoImage,
  findRepoBySlug,
  loadReposConfig,
  type BuildManifest,
  type NormalizedRepoConfig,
} from "./build/devcontainer-image.js";

type CliOptions = {
  repoSlug: string;
  commitSha?: string;
  registryPort: string;
};

const defaultRepoSlug = "microsoft-vscode-remote-try-node";
const defaultRegistryPort = "5001";

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const repos = await loadReposConfig(repoRoot);
  const repo = findRepoBySlug(repos, options.repoSlug);
  const commitSha = options.commitSha ?? await resolveCommitSha(repo);

  process.env.DEVCONTAINER_REGISTRY_URL ??= `localhost:${options.registryPort}/the-furnace`;
  process.env.DEVCONTAINER_REGISTRY_TOKEN ??= "local-registry-token";
  process.env.TARGET_REPO_GITHUB_TOKEN ??= "dummy";

  await ensureLocalRegistry(options.registryPort);

  console.log(`Building ${repo.slug} at ${commitSha}`);
  console.log(`Registry: ${process.env.DEVCONTAINER_REGISTRY_URL}`);

  const manifestFilename = "manifest.local.json";
  const manifest = await buildRepoImage({ repoRoot, repoSlug: repo.slug, commitSha, manifestFilename });
  await verifyImage(manifest);

  console.log("");
  console.log(`Manifest: ${path.join(repoRoot, "build", manifest.repoSlug, manifestFilename)}`);
  console.log(`Image: ${manifest.imageRef}`);
  console.log("Local E2E passed. (manifest.local.json is gitignored.)");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "Usage:",
      "  npm run test:devcontainer:e2e -- [--repo <slug>] [--sha <commitSha>] [--registry-port <port>]",
      "",
      `Defaults: --repo ${defaultRepoSlug} --registry-port ${defaultRegistryPort}`,
    ].join("\n"));
    process.exit(0);
  }

  return {
    repoSlug: readArgValue(argv, "--repo") ?? defaultRepoSlug,
    commitSha: readArgValue(argv, "--sha"),
    registryPort: readArgValue(argv, "--registry-port") ?? defaultRegistryPort,
  };
}

async function resolveCommitSha(repo: NormalizedRepoConfig): Promise<string> {
  const output = await runProcess("git", [
    "ls-remote",
    `https://github.com/${repo.owner}/${repo.name}.git`,
    `refs/heads/${repo.ref}`,
  ], { stream: false });
  const commitSha = output.stdout.trim().split(/\s+/)[0];
  if (!commitSha) {
    throw new Error(`Unable to resolve ${repo.owner}/${repo.name} ref '${repo.ref}' via git ls-remote`);
  }
  return commitSha;
}

async function ensureLocalRegistry(port: string): Promise<void> {
  const name = `furnace-local-registry-${port}`;
  const inspect = await runProcess("docker", ["inspect", "--format", "{{.State.Running}}", name], {
    allowFailure: true,
    stream: false,
  });

  if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
    return;
  }

  if (inspect.exitCode === 0) {
    await runProcess("docker", ["start", name]);
    return;
  }

  await runProcess("docker", ["run", "-d", "--name", name, "-p", `${port}:5000`, "registry:2"]);
}

async function verifyImage(manifest: BuildManifest): Promise<void> {
  await runProcess("docker", ["pull", "--platform", "linux/amd64", manifest.imageRef]);
  const head = await runProcess("docker", [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    manifest.imageRef,
    "sh",
    "-lc",
    `cd ${shellQuote(manifest.workspacePath)} && test -f package.json && test -d node_modules && git rev-parse HEAD`,
  ]);

  const actualSha = head.stdout.trim().split(/\s+/).at(-1);
  if (actualSha !== manifest.commitSha) {
    throw new Error(`Image checkout SHA mismatch: expected ${manifest.commitSha}, got ${actualSha ?? "<empty>"}`);
  }

  await runProcess("docker", [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    manifest.imageRef,
    "sh",
    "-lc",
    "test ! -e /opt/furnace",
  ]);
}

type RunProcessOptions = {
  allowFailure?: boolean;
  stream?: boolean;
};

type RunProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (options.stream !== false) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (options.stream !== false) {
        process.stderr.write(text);
      }
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      const code = exitCode ?? 1;
      if (code === 0 || options.allowFailure) {
        resolve({ exitCode: code, stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}\n${stdout}\n${stderr}`.trim()));
    });
  });
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
