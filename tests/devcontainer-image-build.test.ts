import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRequiredEnv,
  buildStaleRepos,
  createManifest,
  fetchCurrentCommitSha,
  manifestContainsSecrets,
  parseCliArgs,
  planStaleBuilds,
  renderWarmupDockerfile,
  resolveWorkspacePath,
  validateReposConfig,
  type BuildManifest,
  type NormalizedRepoConfig,
} from "../scripts/build/devcontainer-image.js";

const repo: NormalizedRepoConfig = {
  slug: "acme-app",
  owner: "acme",
  name: "app",
  ref: "main",
  devcontainerPath: ".devcontainer/devcontainer.json",
};

const digest = `sha256:${"a".repeat(64)}`;

describe("devcontainer image build contracts", () => {
  it("fails fast with named missing env vars", () => {
    expect(() => assertRequiredEnv({})).toThrow(
      /DEVCONTAINER_REGISTRY_URL, DEVCONTAINER_REGISTRY_TOKEN, TARGET_REPO_GITHUB_TOKEN/,
    );

    expect(() =>
      assertRequiredEnv({
        DEVCONTAINER_REGISTRY_URL: "ghcr.io/acme",
        DEVCONTAINER_REGISTRY_TOKEN: "token",
      }),
    ).toThrow(/TARGET_REPO_GITHUB_TOKEN/);
  });

  it("validates repos config, slug mismatches, and normalized slug collisions", () => {
    expect(() => validateReposConfig([{ owner: "acme", name: "app" }])).toThrow(/slug/);

    expect(() =>
      validateReposConfig([
        {
          slug: "custom",
          owner: "acme",
          name: "app",
        },
      ]),
    ).toThrow(/expected normalized slug 'acme-app'/);

    expect(() =>
      validateReposConfig([
        {
          slug: "acme-app",
          owner: "Acme",
          name: "app",
        },
        {
          slug: "acme-app",
          owner: "acme",
          name: "app",
        },
      ]),
    ).toThrow(/Repo slug collision/);

    expect(
      validateReposConfig([
        {
          slug: "acme-app",
          owner: "acme",
          name: "app",
        },
      ]),
    ).toEqual([
      {
        slug: "acme-app",
        owner: "acme",
        name: "app",
        ref: "main",
        devcontainerPath: ".devcontainer/devcontainer.json",
        workspacePath: undefined,
        warmupCommand: undefined,
      },
    ]);
  });

  it("resolves workspace paths with explicit, devcontainer, and fallback values", () => {
    expect(resolveWorkspacePath({ ...repo, workspacePath: "/workspace/acme" }, { workspaceFolder: "/ignored" })).toBe(
      "/workspace/acme",
    );

    expect(resolveWorkspacePath(repo, { workspaceFolder: "/workspaces/from-devcontainer" })).toBe(
      "/workspaces/from-devcontainer",
    );

    expect(resolveWorkspacePath(repo, {})).toBe("/workspaces/app");
  });

  it("rejects relative and unresolved workspace paths", () => {
    expect(() => resolveWorkspacePath({ ...repo, workspacePath: "relative/path" }, {})).toThrow(/not absolute/);
    expect(() => resolveWorkspacePath(repo, { workspaceFolder: "/workspaces/${localWorkspaceFolderBasename}" })).toThrow(
      /unresolved variables/,
    );
  });

  it("plans stale builds for missing and changed manifests only", () => {
    const changedRepo = { ...repo, slug: "acme-api", name: "api" };
    const missingRepo = { ...repo, slug: "acme-missing", name: "missing" };
    const repos = [repo, changedRepo, missingRepo];
    const currentShas = new Map([
      [repo.slug, "sha-a"],
      [changedRepo.slug, "sha-b"],
      [missingRepo.slug, "sha-c"],
    ]);
    const manifests = new Map<string, BuildManifest>([
      [repo.slug, manifestFor(repo, "sha-a")],
      [changedRepo.slug, manifestFor(changedRepo, "old-sha")],
    ]);

    expect(planStaleBuilds(repos, currentShas, manifests)).toEqual([
      { repo: changedRepo, commitSha: "sha-b", reason: "changed" },
      { repo: missingRepo, commitSha: "sha-c", reason: "missing-manifest" },
    ]);
  });

  it("continues scheduled stale polling after one repo fails discovery", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "furnace-devcontainer-test-"));
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      DEVCONTAINER_REGISTRY_URL: process.env.DEVCONTAINER_REGISTRY_URL,
      DEVCONTAINER_REGISTRY_TOKEN: process.env.DEVCONTAINER_REGISTRY_TOKEN,
      TARGET_REPO_GITHUB_TOKEN: process.env.TARGET_REPO_GITHUB_TOKEN,
    };
    const badRepo: NormalizedRepoConfig = {
      slug: "bad-repo",
      owner: "bad",
      name: "repo",
      ref: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
    };
    const seenUrls: string[] = [];

    try {
      await mkdir(path.join(repoRoot, "build", repo.slug), { recursive: true });
      await writeFile(
        path.join(repoRoot, "build", "repos.json"),
        JSON.stringify([badRepo, repo], null, 2),
      );
      await writeFile(
        path.join(repoRoot, "build", repo.slug, "manifest.json"),
        JSON.stringify(manifestFor(repo, "sha-a"), null, 2),
      );

      process.env.DEVCONTAINER_REGISTRY_URL = "ghcr.io/acme";
      process.env.DEVCONTAINER_REGISTRY_TOKEN = "registry-token";
      process.env.TARGET_REPO_GITHUB_TOKEN = "github-token";
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        seenUrls.push(url);
        if (url.includes("/repos/bad/repo/")) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            json: async () => ({}),
          };
        }

        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ sha: "sha-a" }),
        };
      }) as typeof fetch;

      await expect(buildStaleRepos(repoRoot)).rejects.toThrow(/bad-repo \(bad\/repo\).*404 Not Found/s);
      expect(seenUrls.some((url) => url.includes("/repos/acme/app/"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(originalEnv);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("validates CLI modes and mode-specific options", () => {
    expect(parseCliArgs(["--repo", "acme-app", "--sha", "abc123"])).toEqual({
      mode: "repo",
      repoSlug: "acme-app",
      commitSha: "abc123",
    });
    expect(parseCliArgs(["--stale"])).toEqual({ mode: "stale" });
    expect(parseCliArgs(["--all", "--use-manifest-sha"])).toEqual({ mode: "all", useManifestSha: true });

    expect(() => parseCliArgs([])).toThrow(/Specify exactly one/);
    expect(() => parseCliArgs(["--repo", "acme-app", "--stale"])).toThrow(/Specify exactly one/);
    expect(() => parseCliArgs(["--sha", "abc123", "--stale"])).toThrow(/--sha can only be used with --repo/);
    expect(() => parseCliArgs(["--use-manifest-sha", "--stale"])).toThrow(/--use-manifest-sha can only be used with --all/);
  });

  it("reports unauthorized or not-found target repo access with slug and repo identity", async () => {
    await expect(
      fetchCurrentCommitSha(repo, "secret", async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({}),
      })),
    ).rejects.toThrow(/acme-app \(acme\/app\).*404 Not Found/);
  });

  it("creates digest manifest refs without leaking registry or source tokens", () => {
    const manifest = createManifest({
      repo: { ...repo, warmupCommand: "npm ci" },
      commitSha: "abc123",
      imageDigest: digest,
      registryBase: "https://ghcr.io/acme/",
      workspacePath: "/workspaces/app",
      devcontainerCliVersion: "0.85.0",
      builtAt: "2026-04-26T00:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      repoSlug: "acme-app",
      imageDigest: digest,
      imageRef: `ghcr.io/acme/furnace-acme-app@${digest}`,
      aliasTags: ["sha-abc123", "main"],
      workspacePath: "/workspaces/app",
      warmupCommand: "npm ci",
    });
    expect(manifestContainsSecrets(manifest, ["registry-token", "github-token"])).toBe(false);
    expect(manifestContainsSecrets({ ...manifest, imageRef: "registry-token" }, ["registry-token"])).toBe(true);
  });

  it("renders a warmup Dockerfile without lifecycle replay, furnace content, or CMD override", () => {
    const dockerfile = renderWarmupDockerfile({
      baseImage: "furnace-acme-app-base:abc123",
      workspacePath: "/workspaces/app",
      warmupCommand: "npm ci",
    });

    expect(dockerfile).toContain("FROM furnace-acme-app-base:abc123");
    expect(dockerfile).toContain('COPY ["source/", "/workspaces/app/"]');
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).not.toMatch(/onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand/);
    expect(dockerfile).not.toContain("/opt/furnace");
    expect(dockerfile).not.toMatch(/^CMD /m);
  });
});

function manifestFor(testRepo: NormalizedRepoConfig, commitSha: string): BuildManifest {
  return createManifest({
    repo: testRepo,
    commitSha,
    imageDigest: digest,
    registryBase: "ghcr.io/acme",
    workspacePath: `/workspaces/${testRepo.name}`,
    devcontainerCliVersion: "0.85.0",
    builtAt: "2026-04-26T00:00:00.000Z",
  });
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
