import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWorkerAuthAvailable,
  launchWorkerContainer,
  type LaunchWorkerContainerInput,
  type LaunchWorkerContainerOptions,
} from "../src/worker-launcher.js";

const statAsync = promisify(stat);

const fakeManifest = async (): Promise<{ imageRef: string }> => ({
  imageRef: "registry.example/test@sha256:abc",
});

const baseInput: LaunchWorkerContainerInput = {
  ticketId: "ticket-1",
  phase: "spec",
  attemptId: "attempt-1",
  repoSlug: "test-repo",
};

async function withTmpLogsDir(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.LOGS_DIR) return env;
  const dir = await mkdtemp(path.join(os.tmpdir(), "furnace-logs-"));
  return { ...env, LOGS_DIR: dir };
}

async function runLauncherCapturingArgs(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  let captured: string[] = [];
  const options: LaunchWorkerContainerOptions = {
    env: await withTmpLogsDir(env),
    loadManifest: fakeManifest,
    runDocker: async (args) => {
      captured = args;
      return { containerId: "fake-container" };
    },
  };
  await launchWorkerContainer(baseInput, options);
  return captured;
}

const credsMountPattern = /^type=bind,source=.+,target=\/root\/\.claude,readonly$/;

describe("launchWorkerContainer docker args", () => {
  it("uses REPO_ROOT override for default build and bundle dirs", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "furnace-repo-root-"));
    let capturedBuildDir = "";
    let captured: string[] = [];

    await launchWorkerContainer(baseInput, {
      env: {
        REPO_ROOT: repoRoot,
        CLAUDE_CREDS_DIR: "/tmp/creds",
      },
      loadManifest: async (_slug, buildDir) => {
        capturedBuildDir = buildDir;
        return { imageRef: "registry.example/test@sha256:abc" };
      },
      runDocker: async (args) => {
        captured = args;
        return { containerId: "fake-container" };
      },
    });

    expect(capturedBuildDir).toBe(path.join(repoRoot, "build"));
    const mountValues = collectMountValues(captured);
    expect(mountValues).toContain(
      `type=bind,source=${path.join(repoRoot, "dist", "worker")},target=/opt/furnace,readonly`,
    );
    // Default LOGS_DIR is `<repoRoot>/data/logs`; the per-attempt subdir is
    // mounted read-write at /var/log/furnace.
    expect(mountValues).toContain(
      `type=bind,source=${path.join(repoRoot, "data", "logs", baseInput.attemptId)},target=/var/log/furnace`,
    );
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("forwards ANTHROPIC_API_KEY env var alongside the credentials mount", async () => {
    const args = await runLauncherCapturingArgs({
      WORKER_BUNDLE_DIR: "/tmp/bundle",
      CLAUDE_CREDS_DIR: "/tmp/creds",
      BUILD_DIR: "/tmp/build",
      ANTHROPIC_API_KEY: "sk-test-123",
    });

    const envPairs = collectEnvPairs(args);
    expect(envPairs).toContain("ANTHROPIC_API_KEY=sk-test-123");

    const mountValues = collectMountValues(args);
    expect(mountValues.some((v) => credsMountPattern.test(v))).toBe(true);
    expect(mountValues).toContain(
      "type=bind,source=/tmp/creds,target=/root/.claude,readonly",
    );
  });

  it("forwards CLAUDE_CODE_OAUTH_TOKEN env var alongside the credentials mount", async () => {
    const args = await runLauncherCapturingArgs({
      WORKER_BUNDLE_DIR: "/tmp/bundle",
      CLAUDE_CREDS_DIR: "/tmp/creds",
      BUILD_DIR: "/tmp/build",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-456",
    });

    const envPairs = collectEnvPairs(args);
    expect(envPairs).toContain("CLAUDE_CODE_OAUTH_TOKEN=oauth-test-456");
    expect(envPairs.every((p) => !p.startsWith("ANTHROPIC_API_KEY"))).toBe(true);

    const mountValues = collectMountValues(args);
    expect(mountValues).toContain(
      "type=bind,source=/tmp/creds,target=/root/.claude,readonly",
    );
  });

  it("forwards both auth env vars when both are set", async () => {
    const args = await runLauncherCapturingArgs({
      WORKER_BUNDLE_DIR: "/tmp/bundle",
      CLAUDE_CREDS_DIR: "/tmp/creds",
      BUILD_DIR: "/tmp/build",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-456",
      ANTHROPIC_API_KEY: "sk-test-123",
    });

    const envPairs = collectEnvPairs(args);
    expect(envPairs).toContain("CLAUDE_CODE_OAUTH_TOKEN=oauth-test-456");
    expect(envPairs).toContain("ANTHROPIC_API_KEY=sk-test-123");
  });

  it("retains the credentials mount and omits both auth env vars when unset", async () => {
    const args = await runLauncherCapturingArgs({
      WORKER_BUNDLE_DIR: "/tmp/bundle",
      CLAUDE_CREDS_DIR: "/tmp/creds",
      BUILD_DIR: "/tmp/build",
      // both auth env vars intentionally absent
    });

    const envPairs = collectEnvPairs(args);
    expect(envPairs.every((p) => !p.startsWith("ANTHROPIC_API_KEY"))).toBe(true);
    expect(envPairs.every((p) => !p.startsWith("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(true);
    // Bare `--env <NAME>` (passthrough form) is also disallowed.
    expect(args.some((a, i) => a === "--env" && args[i + 1] === "ANTHROPIC_API_KEY")).toBe(
      false,
    );
    expect(
      args.some((a, i) => a === "--env" && args[i + 1] === "CLAUDE_CODE_OAUTH_TOKEN"),
    ).toBe(false);

    const mountValues = collectMountValues(args);
    expect(mountValues).toContain(
      "type=bind,source=/tmp/creds,target=/root/.claude,readonly",
    );
  });

  it("treats empty ANTHROPIC_API_KEY as unset", async () => {
    const args = await runLauncherCapturingArgs({
      WORKER_BUNDLE_DIR: "/tmp/bundle",
      CLAUDE_CREDS_DIR: "/tmp/creds",
      BUILD_DIR: "/tmp/build",
      ANTHROPIC_API_KEY: "",
    });

    const envPairs = collectEnvPairs(args);
    expect(envPairs.some((p) => p.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
  });

  it("treats empty CLAUDE_CODE_OAUTH_TOKEN as unset", async () => {
    const args = await runLauncherCapturingArgs({
      WORKER_BUNDLE_DIR: "/tmp/bundle",
      CLAUDE_CREDS_DIR: "/tmp/creds",
      BUILD_DIR: "/tmp/build",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });

    const envPairs = collectEnvPairs(args);
    expect(envPairs.some((p) => p.startsWith("CLAUDE_CODE_OAUTH_TOKEN="))).toBe(false);
  });
});

function collectEnvPairs(args: string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--env") {
      pairs.push(args[i + 1]);
    }
  }
  return pairs;
}

function collectMountValues(args: string[]): string[] {
  const mounts: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--mount") {
      mounts.push(args[i + 1]);
    }
  }
  return mounts;
}

describe("launchWorkerContainer log mount", () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = await mkdtemp(path.join(os.tmpdir(), "furnace-logs-"));
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it("mounts the per-attempt log dir read-write, creates it on disk, and surfaces logsPath", async () => {
    let captured: string[] = [];
    const result = await launchWorkerContainer(baseInput, {
      env: {
        WORKER_BUNDLE_DIR: "/tmp/bundle",
        CLAUDE_CREDS_DIR: "/tmp/creds",
        BUILD_DIR: "/tmp/build",
        LOGS_DIR: logsDir,
      },
      loadManifest: fakeManifest,
      runDocker: async (args) => {
        captured = args;
        return { containerId: "fake-container" };
      },
    });

    const expectedAttemptDir = path.join(logsDir, baseInput.attemptId);

    // (a) bind mount with no readonly flag, target /var/log/furnace
    const mountValues = collectMountValues(captured);
    expect(mountValues).toContain(
      `type=bind,source=${expectedAttemptDir},target=/var/log/furnace`,
    );
    expect(
      mountValues.some((v) =>
        v.startsWith(`type=bind,source=${expectedAttemptDir},target=/var/log/furnace`)
        && v.includes("readonly"),
      ),
    ).toBe(false);

    // (b) per-attempt directory exists on disk
    const stats = await statAsync(expectedAttemptDir);
    expect(stats.isDirectory()).toBe(true);

    // (c) result includes logsPath
    expect(result.logsPath).toBe(expectedAttemptDir);

    // (d) trailing argv invokes sh -c with the tee wrapper
    expect(captured.slice(-3)).toEqual([
      "sh",
      "-c",
      "exec node /opt/furnace/worker-entry.js 2>&1 | tee /var/log/furnace/container.log",
    ]);
  });

  it("captures host-side container.log when the worker entry runs as a child process under tee", async () => {
    // Stub runDocker to spawn a child mimicking the container CMD pattern:
    // `sh -c '... | tee <hostPath>'`. Asserts that worker stdout/stderr
    // ends up in container.log on the host even after the child exits,
    // simulating --rm.
    const expectedAttemptDir = path.join(logsDir, baseInput.attemptId);
    const containerLog = path.join(expectedAttemptDir, "container.log");

    const result = await launchWorkerContainer(baseInput, {
      env: {
        WORKER_BUNDLE_DIR: "/tmp/bundle",
        CLAUDE_CREDS_DIR: "/tmp/creds",
        BUILD_DIR: "/tmp/build",
        LOGS_DIR: logsDir,
      },
      loadManifest: fakeManifest,
      runDocker: async (args) => {
        // Find the sh -c wrapper and rewrite the in-container path to the
        // host-side path so the host shell can tee to it directly.
        const idx = args.findIndex((a) => a === "sh");
        expect(args[idx + 1]).toBe("-c");
        const innerCmd = args[idx + 2];
        // Rewrite: the production CMD writes to /var/log/furnace which
        // resolves via the bind mount to expectedAttemptDir on the host.
        const hostCmd = innerCmd.replace(
          "/var/log/furnace/container.log",
          containerLog,
        );
        // Replace the bundled-node invocation with a host-side echo that
        // mimics worker-entry.ts:76's "[container-worker] starting ..." banner.
        const stubbedCmd = hostCmd.replace(
          /exec node \/opt\/furnace\/worker-entry\.js/,
          "echo '[container-worker] starting repo=test-repo languages=<none> tools=<none> attempt=attempt-1'",
        );
        await new Promise<void>((resolve, reject) => {
          const child = spawnSh(stubbedCmd);
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`stub exited ${code}`));
          });
        });
        return { containerId: "stub-container" };
      },
    });

    expect(result.logsPath).toBe(expectedAttemptDir);

    const contents = await readFile(containerLog, "utf8");
    expect(contents).toContain("[container-worker] starting");
  });
});

function spawnSh(cmd: string): ChildProcess {
  return spawn("sh", ["-c", cmd], { stdio: ["ignore", "inherit", "inherit"] });
}

describe("assertWorkerAuthAvailable", () => {
  let credsDir: string;

  beforeEach(async () => {
    credsDir = await mkdtemp(path.join(os.tmpdir(), "furnace-creds-"));
  });

  afterEach(async () => {
    await rm(credsDir, { recursive: true, force: true });
  });

  it("passes when ANTHROPIC_API_KEY is set, even with empty creds dir", async () => {
    await expect(
      assertWorkerAuthAvailable({
        ANTHROPIC_API_KEY: "sk-key",
        CLAUDE_CREDS_DIR: credsDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when CLAUDE_CODE_OAUTH_TOKEN is set, even with empty creds dir", async () => {
    await expect(
      assertWorkerAuthAvailable({
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        CLAUDE_CREDS_DIR: credsDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when creds dir exists and is non-empty (no env vars)", async () => {
    await writeFile(path.join(credsDir, "settings.json"), "{}");
    await expect(
      assertWorkerAuthAvailable({ CLAUDE_CREDS_DIR: credsDir }),
    ).resolves.toBeUndefined();
  });

  it("throws naming all three options when none is viable", async () => {
    // credsDir exists but is empty, and no env vars.
    let caught: unknown;
    try {
      await assertWorkerAuthAvailable({ CLAUDE_CREDS_DIR: credsDir });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(msg).toContain("ANTHROPIC_API_KEY");
    expect(msg).toContain(credsDir);
    expect(msg.split("\n")).toHaveLength(1);
  });

  it("throws when creds dir is missing entirely and no env vars are set", async () => {
    const missing = path.join(credsDir, "does-not-exist");
    let caught: unknown;
    try {
      await assertWorkerAuthAvailable({ CLAUDE_CREDS_DIR: missing });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(msg).toContain("ANTHROPIC_API_KEY");
    expect(msg).toContain(missing);
  });

  it("treats empty-string env vars as unset", async () => {
    await expect(
      assertWorkerAuthAvailable({
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CREDS_DIR: credsDir,
      }),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN[\s\S]*ANTHROPIC_API_KEY/);
  });
});
