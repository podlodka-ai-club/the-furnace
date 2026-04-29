import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

// Build the container worker bundle. The output directory is bind-mounted
// read-only at /opt/furnace inside per-repo containers — the per-repo image
// itself carries no furnace runtime code. See:
//   openspec/changes/container-as-worker/design.md (decision 5)
//   openspec/specs/container-worker-lifecycle/spec.md (worker bundle is bind-mounted)
//
// Pipeline:
//   1. tsc --project server/tsconfig.worker.json  (emits only files reachable
//      from worker-entry.ts; orchestrator-only code is excluded by the
//      `files: ["src/worker-entry.ts"]` graph).
//   2. Write a minimal package.json declaring the runtime deps the entrypoint
//      and its imports need.
//   3. npm install --omit=dev --prefix dist/worker  (resolves the dep subset).

interface BuildOptions {
  repoRoot: string;
  skipInstall: boolean;
}

const RUNTIME_DEPS: ReadonlyArray<readonly [string, string]> = [
  ["@anthropic-ai/claude-agent-sdk", "^0.1.0"],
  ["@linear/sdk", "^82.1.0"],
  ["@temporalio/worker", "^1.16.1"],
  ["@temporalio/activity", "^1.16.1"],
  ["zod", "^4.3.6"],
];

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const options: BuildOptions = {
    repoRoot: process.cwd(),
    skipInstall: argv.includes("--skip-install"),
  };

  const distDir = path.join(options.repoRoot, "dist", "worker");
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  console.log("[build:worker] tsc --project server/tsconfig.worker.json");
  await runProcess("npx", ["tsc", "--project", "server/tsconfig.worker.json"], {
    cwd: options.repoRoot,
  });

  await writePackageJson(distDir, options);

  if (options.skipInstall) {
    console.log("[build:worker] skipping npm install (--skip-install)");
    return;
  }

  await ensureRuntimeDeps(distDir, options);
  console.log(`[build:worker] bundle ready at ${distDir}`);
}

async function writePackageJson(distDir: string, options: BuildOptions): Promise<void> {
  const rootPackage = JSON.parse(
    await readFile(path.join(options.repoRoot, "server", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = rootPackage.dependencies ?? {};

  const dependencies: Record<string, string> = {};
  for (const [name, fallback] of RUNTIME_DEPS) {
    dependencies[name] = deps[name] ?? fallback;
  }

  const pkg = {
    name: "the-furnace-worker-bundle",
    version: "0.0.0",
    private: true,
    type: "module",
    main: "worker-entry.js",
    dependencies,
  };

  await writeFile(path.join(distDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

async function ensureRuntimeDeps(distDir: string, options: BuildOptions): Promise<void> {
  console.log("[build:worker] npm install --omit=dev (resolves runtime dep subset)");
  await runProcess("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: distDir,
  });
}

interface RunProcessOptions {
  cwd: string;
}

async function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
