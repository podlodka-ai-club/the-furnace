import { describe, expect, it } from "vitest";

import {
  assertRequiredEnv,
  createManifest,
  fetchCurrentCommitSha,
  manifestContainsSecrets,
  parseCliArgs,
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

  it("validates the on-demand CLI mode and mode-specific options", () => {
    expect(parseCliArgs(["--repo", "acme-app"])).toEqual({
      mode: "repo",
      repoSlug: "acme-app",
      commitSha: undefined,
    });
    expect(parseCliArgs(["--repo", "acme-app", "--sha", "abc123"])).toEqual({
      mode: "repo",
      repoSlug: "acme-app",
      commitSha: "abc123",
    });

    expect(() => parseCliArgs([])).toThrow(/Specify --repo/);
    expect(() => parseCliArgs(["--sha", "abc123"])).toThrow(/--sha requires --repo/);
    expect(() => parseCliArgs(["--stale"])).toThrow(/not supported/);
    expect(() => parseCliArgs(["--all"])).toThrow(/not supported/);
    expect(() => parseCliArgs(["--use-manifest-sha"])).toThrow(/not supported/);
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
    expect(dockerfile).toContain('COPY --chown=node:node ["source/", "/workspaces/app/"]');
    expect(dockerfile).toContain("RUN chown -R node:node /workspaces/app");
    expect(dockerfile).toContain("USER node");
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
