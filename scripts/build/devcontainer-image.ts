import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const REQUIRED_ENV = [
  "DEVCONTAINER_REGISTRY_URL",
  "DEVCONTAINER_REGISTRY_TOKEN",
  "TARGET_REPO_GITHUB_TOKEN",
] as const;

type RequiredEnvName = (typeof REQUIRED_ENV)[number];

export type RepoConfig = {
  slug: string;
  owner: string;
  name: string;
  ref?: string;
  devcontainerPath?: string;
  workspacePath?: string;
  warmupCommand?: string;
};

export type NormalizedRepoConfig = Required<Pick<RepoConfig, "slug" | "owner" | "name" | "ref" | "devcontainerPath">> &
  Pick<RepoConfig, "workspacePath" | "warmupCommand">;

export type BuildManifest = {
  repoSlug: string;
  owner: string;
  name: string;
  ref: string;
  commitSha: string;
  imageDigest: string;
  imageRef: string;
  aliasTags: string[];
  builtAt: string;
  workspacePath: string;
  devcontainerCliVersion: string;
  warmupCommand: string | null;
};

export type RequiredBuildEnv = Record<RequiredEnvName, string>;

export type BuildPlanItem = {
  repo: NormalizedRepoConfig;
  commitSha: string;
  reason: "missing-manifest" | "changed";
};

type StaleBuildFailure = {
  repo: NormalizedRepoConfig;
  error: unknown;
};

type CliOptions =
  | { mode: "repo"; repoSlug: string; commitSha?: string }
  | { mode: "stale" }
  | { mode: "all"; useManifestSha: boolean }
  | { mode: "help" };

type RunProcessOptions = {
  cwd?: string;
  input?: string;
  secrets?: string[];
  stream?: boolean;
};

type RunProcessResult = {
  stdout: string;
  stderr: string;
};

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

export class DevcontainerImageBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevcontainerImageBuildError";
  }
}

export function normalizeRepoSlug(owner: string, name: string): string {
  return `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env): RequiredBuildEnv {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new DevcontainerImageBuildError(`Missing required env var(s): ${missing.join(", ")}`);
  }

  return {
    DEVCONTAINER_REGISTRY_URL: env.DEVCONTAINER_REGISTRY_URL ?? "",
    DEVCONTAINER_REGISTRY_TOKEN: env.DEVCONTAINER_REGISTRY_TOKEN ?? "",
    TARGET_REPO_GITHUB_TOKEN: env.TARGET_REPO_GITHUB_TOKEN ?? "",
  };
}

export async function loadReposConfig(repoRoot = process.cwd()): Promise<NormalizedRepoConfig[]> {
  const reposPath = path.join(repoRoot, "build", "repos.json");
  const raw = await readFile(reposPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateReposConfig(parsed);
}

export function validateReposConfig(parsed: unknown): NormalizedRepoConfig[] {
  if (!Array.isArray(parsed)) {
    throw new DevcontainerImageBuildError("build/repos.json must contain an array of repo entries");
  }

  const normalized = parsed.map((entry, index) => normalizeRepoConfigEntry(entry, index));
  const bySlug = new Map<string, NormalizedRepoConfig>();

  for (const repo of normalized) {
    const existing = bySlug.get(repo.slug);
    if (existing) {
      throw new DevcontainerImageBuildError(
        `Repo slug collision for '${repo.slug}': ${existing.owner}/${existing.name} and ${repo.owner}/${repo.name}`,
      );
    }
    bySlug.set(repo.slug, repo);
  }

  return normalized;
}

export function findRepoBySlug(repos: NormalizedRepoConfig[], slug: string): NormalizedRepoConfig {
  const repo = repos.find((entry) => entry.slug === slug);
  if (!repo) {
    throw new DevcontainerImageBuildError(`No tracked repo found for slug '${slug}'`);
  }
  return repo;
}

export async function fetchCurrentCommitSha(
  repo: NormalizedRepoConfig,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const ref = encodeURIComponent(repo.ref);
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${ref}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "the-furnace-devcontainer-image-builder",
    },
  });

  if (!response.ok) {
    throw new DevcontainerImageBuildError(
      `Unable to read ${repo.slug} (${repo.owner}/${repo.name}) ref '${repo.ref}' from GitHub: ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json();
  if (!isRecord(body) || typeof body.sha !== "string" || body.sha.length === 0) {
    throw new DevcontainerImageBuildError(
      `GitHub response for ${repo.slug} (${repo.owner}/${repo.name}) did not include a commit SHA`,
    );
  }

  return body.sha;
}

export function resolveWorkspacePath(
  repo: NormalizedRepoConfig,
  devcontainerConfig: Record<string, unknown>,
): string {
  const value = repo.workspacePath ?? valueAsString(devcontainerConfig.workspaceFolder) ?? `/workspaces/${repo.name}`;
  if (!value.startsWith("/")) {
    throw new DevcontainerImageBuildError(`Invalid workspace path for ${repo.slug}: '${value}' is not absolute`);
  }
  if (value.includes("${")) {
    throw new DevcontainerImageBuildError(
      `Invalid workspace path for ${repo.slug}: '${value}' contains unresolved variables`,
    );
  }
  return value;
}

export function planStaleBuilds(
  repos: NormalizedRepoConfig[],
  currentShas: Map<string, string>,
  manifests: Map<string, BuildManifest>,
): BuildPlanItem[] {
  const plan: BuildPlanItem[] = [];

  for (const repo of repos) {
    const currentSha = currentShas.get(repo.slug);
    if (!currentSha) {
      throw new DevcontainerImageBuildError(`Missing current SHA for ${repo.slug}`);
    }

    const manifest = manifests.get(repo.slug);
    if (!manifest) {
      plan.push({ repo, commitSha: currentSha, reason: "missing-manifest" });
      continue;
    }

    if (manifest.commitSha !== currentSha) {
      plan.push({ repo, commitSha: currentSha, reason: "changed" });
    }
  }

  return plan;
}

export function createManifest(input: {
  repo: NormalizedRepoConfig;
  commitSha: string;
  imageDigest: string;
  registryBase: string;
  workspacePath: string;
  devcontainerCliVersion: string;
  builtAt?: string;
}): BuildManifest {
  const imageRepository = buildImageRepository(input.registryBase, input.repo.slug);
  const aliasTags = [`sha-${input.commitSha}`, "main"];
  return {
    repoSlug: input.repo.slug,
    owner: input.repo.owner,
    name: input.repo.name,
    ref: input.repo.ref,
    commitSha: input.commitSha,
    imageDigest: input.imageDigest,
    imageRef: `${imageRepository}@${input.imageDigest}`,
    aliasTags,
    builtAt: input.builtAt ?? new Date().toISOString(),
    workspacePath: input.workspacePath,
    devcontainerCliVersion: input.devcontainerCliVersion,
    warmupCommand: input.repo.warmupCommand ?? null,
  };
}

export function manifestContainsSecrets(manifest: BuildManifest, secrets: string[]): boolean {
  const manifestJson = JSON.stringify(manifest);
  return secrets.filter((secret) => secret.length > 0).some((secret) => manifestJson.includes(secret));
}

export function renderWarmupDockerfile(input: {
  baseImage: string;
  workspacePath: string;
  warmupCommand?: string;
}): string {
  const lines = [
    `FROM ${input.baseImage}`,
    `WORKDIR ${input.workspacePath}`,
    `COPY ["source/", "${withTrailingSlash(input.workspacePath)}"]`,
  ];

  if (input.warmupCommand) {
    lines.push(`RUN ${input.warmupCommand}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function readDevcontainerConfig(
  checkoutDir: string,
  repo: NormalizedRepoConfig,
): Promise<Record<string, unknown>> {
  const devcontainerJsonPath = path.join(checkoutDir, repo.devcontainerPath);
  await assertFileExists(devcontainerJsonPath, `Expected devcontainer.json for ${repo.slug} at ${repo.devcontainerPath}`);

  const raw = await readFile(devcontainerJsonPath, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const details = errors.map((error) => printParseErrorCode(error.error)).join(", ");
    throw new DevcontainerImageBuildError(`Unable to parse devcontainer.json for ${repo.slug}: ${details}`);
  }

  if (!isRecord(parsed)) {
    throw new DevcontainerImageBuildError(`devcontainer.json for ${repo.slug} must contain an object`);
  }

  return parsed;
}

export async function readManifest(repoRoot: string, slug: string): Promise<BuildManifest | undefined> {
  const manifestPath = path.join(repoRoot, "build", slug, "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as BuildManifest;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeManifest(repoRoot: string, manifest: BuildManifest): Promise<void> {
  const manifestDir = path.join(repoRoot, "build", manifest.repoSlug);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(path.join(manifestDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function buildRepoImage(input: {
  repoRoot?: string;
  repoSlug: string;
  commitSha?: string;
}): Promise<BuildManifest> {
  const repoRoot = input.repoRoot ?? process.cwd();
  const env = assertRequiredEnv();
  const registryBase = normalizeRegistryBase(env.DEVCONTAINER_REGISTRY_URL);
  const repos = await loadReposConfig(repoRoot);
  const repo = findRepoBySlug(repos, input.repoSlug);
  const commitSha = input.commitSha ?? (await fetchCurrentCommitSha(repo, env.TARGET_REPO_GITHUB_TOKEN));

  const tempDir = await mkdtemp(path.join(tmpdir(), "furnace-devcontainer-"));
  const checkoutDir = path.join(tempDir, "checkout");
  const warmupContextDir = path.join(tempDir, "warmup-context");
  const imageRepository = buildImageRepository(registryBase, repo.slug);
  const shaTag = `${imageRepository}:sha-${commitSha}`;
  const mainTag = `${imageRepository}:main`;
  const baseImage = `furnace-${repo.slug}-base:${commitSha.slice(0, 12)}`;
  const secrets = [env.DEVCONTAINER_REGISTRY_TOKEN, env.TARGET_REPO_GITHUB_TOKEN];

  try {
    await cloneRepoAtCommit(repo, commitSha, env.TARGET_REPO_GITHUB_TOKEN, checkoutDir, secrets);
    const devcontainerConfig = await readDevcontainerConfig(checkoutDir, repo);
    const workspacePath = resolveWorkspacePath(repo, devcontainerConfig);
    const devcontainerCliVersion = await readDevcontainerCliVersion(repoRoot);

    await runProcess(resolveLocalBin(repoRoot, "devcontainer"), [
      "build",
      "--workspace-folder",
      checkoutDir,
      "--config",
      path.join(checkoutDir, repo.devcontainerPath),
      "--platform",
      "linux/amd64",
      "--image-name",
      baseImage,
    ], { cwd: repoRoot, secrets });

    await mkdir(warmupContextDir, { recursive: true });
    await cp(checkoutDir, path.join(warmupContextDir, "source"), { recursive: true });
    await writeFile(
      path.join(warmupContextDir, "Dockerfile"),
      renderWarmupDockerfile({ baseImage, workspacePath, warmupCommand: repo.warmupCommand }),
    );

    await dockerLogin(env.DEVCONTAINER_REGISTRY_URL, env.DEVCONTAINER_REGISTRY_TOKEN, secrets);
    await runProcess("docker", [
      "build",
      "--platform",
      "linux/amd64",
      "--tag",
      shaTag,
      "--tag",
      mainTag,
      warmupContextDir,
    ], { secrets });

    const shaPush = await runProcess("docker", ["push", shaTag], { secrets });
    const imageDigest = extractDigest(`${shaPush.stdout}\n${shaPush.stderr}`);
    const mainPush = await runProcess("docker", ["push", mainTag], { secrets });
    const mainDigest = extractDigest(`${mainPush.stdout}\n${mainPush.stderr}`);
    if (mainDigest !== imageDigest) {
      throw new DevcontainerImageBuildError(
        `Registry returned different digests for ${shaTag} (${imageDigest}) and ${mainTag} (${mainDigest})`,
      );
    }

    const manifest = createManifest({
      repo,
      commitSha,
      imageDigest,
      registryBase,
      workspacePath,
      devcontainerCliVersion,
    });

    if (manifestContainsSecrets(manifest, secrets)) {
      throw new DevcontainerImageBuildError(`Refusing to write manifest for ${repo.slug}: manifest contains a secret value`);
    }

    await writeManifest(repoRoot, manifest);
    return manifest;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runCli(argv: string[], repoRoot = process.cwd()): Promise<void> {
  const options = parseCliArgs(argv);
  if (options.mode === "help") {
    console.log(helpText());
    return;
  }

  if (options.mode === "repo") {
    const manifest = await buildRepoImage({ repoRoot, repoSlug: options.repoSlug, commitSha: options.commitSha });
    console.log(`Built ${manifest.repoSlug} ${manifest.commitSha} -> ${manifest.imageRef}`);
    return;
  }

  if (options.mode === "stale") {
    await buildStaleRepos(repoRoot);
    return;
  }

  await buildAllRepos(repoRoot, options.useManifestSha);
}

export function parseCliArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { mode: "help" };
  }

  const repoSlug = readArgValue(argv, "--repo");
  const commitSha = readArgValue(argv, "--sha");
  const stale = argv.includes("--stale");
  const all = argv.includes("--all");
  const useManifestSha = argv.includes("--use-manifest-sha");

  const selectedModes = [repoSlug !== undefined, stale, all].filter(Boolean).length;
  if (selectedModes !== 1) {
    throw new DevcontainerImageBuildError("Specify exactly one of --repo <slug>, --stale, or --all");
  }

  if (commitSha && !repoSlug) {
    throw new DevcontainerImageBuildError("--sha can only be used with --repo");
  }

  if (useManifestSha && !all) {
    throw new DevcontainerImageBuildError("--use-manifest-sha can only be used with --all");
  }

  if (repoSlug) {
    return { mode: "repo", repoSlug, commitSha };
  }
  if (stale) {
    return { mode: "stale" };
  }
  return { mode: "all", useManifestSha };
}

export async function buildStaleRepos(repoRoot = process.cwd()): Promise<BuildManifest[]> {
  const env = assertRequiredEnv();
  const repos = await loadReposConfig(repoRoot);
  const currentShas = new Map<string, string>();
  const manifests = new Map<string, BuildManifest>();
  const pollableRepos: NormalizedRepoConfig[] = [];
  const failures: StaleBuildFailure[] = [];

  for (const repo of repos) {
    try {
      currentShas.set(repo.slug, await fetchCurrentCommitSha(repo, env.TARGET_REPO_GITHUB_TOKEN));
      const manifest = await readManifest(repoRoot, repo.slug);
      if (manifest) {
        manifests.set(repo.slug, manifest);
      }
      pollableRepos.push(repo);
    } catch (error) {
      failures.push({ repo, error });
    }
  }

  const plan = planStaleBuilds(pollableRepos, currentShas, manifests);
  if (plan.length === 0 && failures.length === 0) {
    console.log("All tracked devcontainer images are current.");
    return [];
  }

  const results: BuildManifest[] = [];
  for (const item of plan) {
    console.log(`Building ${item.repo.slug} at ${item.commitSha} (${item.reason})`);
    try {
      results.push(await buildRepoImage({ repoRoot, repoSlug: item.repo.slug, commitSha: item.commitSha }));
    } catch (error) {
      failures.push({ repo: item.repo, error });
    }
  }

  if (failures.length > 0) {
    throw buildStaleFailureError(failures);
  }

  return results;
}

export async function buildAllRepos(repoRoot = process.cwd(), useManifestSha = false): Promise<BuildManifest[]> {
  const env = assertRequiredEnv();
  const repos = await loadReposConfig(repoRoot);
  const results: BuildManifest[] = [];

  for (const repo of repos) {
    const manifest = await readManifest(repoRoot, repo.slug);
    const commitSha = useManifestSha && manifest
      ? manifest.commitSha
      : await fetchCurrentCommitSha(repo, env.TARGET_REPO_GITHUB_TOKEN);
    console.log(`Building ${repo.slug} at ${commitSha}`);
    results.push(await buildRepoImage({ repoRoot, repoSlug: repo.slug, commitSha }));
  }

  return results;
}

export function buildImageRepository(registryBase: string, slug: string): string {
  return `${normalizeRegistryBase(registryBase)}/furnace-${slug}`;
}

export function normalizeRegistryBase(registryUrl: string): string {
  return registryUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function registryLoginHost(registryUrl: string): string {
  return normalizeRegistryBase(registryUrl).split("/")[0] ?? "";
}

function normalizeRepoConfigEntry(entry: unknown, index: number): NormalizedRepoConfig {
  if (!isRecord(entry)) {
    throw new DevcontainerImageBuildError(`Repo entry ${index} must be an object`);
  }

  const slug = requiredString(entry.slug, `Repo entry ${index} is missing required string field 'slug'`);
  const owner = requiredString(entry.owner, `Repo entry ${index} is missing required string field 'owner'`);
  const name = requiredString(entry.name, `Repo entry ${index} is missing required string field 'name'`);
  const normalizedSlug = normalizeRepoSlug(owner, name);
  if (slug !== normalizedSlug) {
    throw new DevcontainerImageBuildError(
      `Repo entry ${owner}/${name} has slug '${slug}' but expected normalized slug '${normalizedSlug}'`,
    );
  }

  return {
    slug,
    owner,
    name,
    ref: valueAsString(entry.ref) ?? "main",
    devcontainerPath: valueAsString(entry.devcontainerPath) ?? ".devcontainer/devcontainer.json",
    workspacePath: valueAsString(entry.workspacePath),
    warmupCommand: valueAsString(entry.warmupCommand),
  };
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DevcontainerImageBuildError(message);
  }
  return value;
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function assertFileExists(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DevcontainerImageBuildError(message);
    }
    throw error;
  }
}

async function cloneRepoAtCommit(
  repo: NormalizedRepoConfig,
  commitSha: string,
  token: string,
  checkoutDir: string,
  secrets: string[],
): Promise<void> {
  await mkdir(checkoutDir, { recursive: true });
  const remoteUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo.owner}/${repo.name}.git`;

  try {
    await runProcess("git", ["init", checkoutDir], { secrets });
    await runProcess("git", ["-C", checkoutDir, "remote", "add", "origin", remoteUrl], { secrets });
    await runProcess("git", ["-C", checkoutDir, "fetch", "--depth", "1", "origin", commitSha], { secrets });
    await runProcess("git", ["-C", checkoutDir, "checkout", "--detach", "FETCH_HEAD"], { secrets });
  } catch (error) {
    if (error instanceof Error) {
      throw new DevcontainerImageBuildError(
        `Unable to clone ${repo.slug} (${repo.owner}/${repo.name}) at ${commitSha}: ${sanitize(error.message, secrets)}`,
      );
    }
    throw error;
  }
}

async function dockerLogin(registryUrl: string, token: string, secrets: string[]): Promise<void> {
  const host = registryLoginHost(registryUrl);
  if (!host) {
    throw new DevcontainerImageBuildError(`Invalid DEVCONTAINER_REGISTRY_URL '${registryUrl}'`);
  }
  await runProcess("docker", ["login", host, "--username", "token", "--password-stdin"], {
    input: token,
    secrets,
  });
}

async function readDevcontainerCliVersion(repoRoot: string): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "node_modules", "@devcontainers", "cli", "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof packageJson.version === "string") {
      return packageJson.version;
    }
  } catch {
    // Fall back to package.json below.
  }

  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const pinnedVersion = rootPackage.devDependencies?.["@devcontainers/cli"];
  if (!pinnedVersion) {
    throw new DevcontainerImageBuildError("Unable to determine pinned @devcontainers/cli version");
  }
  return pinnedVersion.replace(/^[^\d]*/, "");
}

async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const secrets = options.secrets ?? [];

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (options.stream !== false) {
        process.stdout.write(sanitize(text, secrets));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (options.stream !== false) {
        process.stderr.write(sanitize(text, secrets));
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new DevcontainerImageBuildError(
          `${command} exited with code ${code}\n${sanitize(stdout, secrets)}\n${sanitize(stderr, secrets)}`.trim(),
        ),
      );
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function extractDigest(output: string): string {
  const match = output.match(/digest:\s*(sha256:[a-f0-9]{64})/i);
  if (!match) {
    throw new DevcontainerImageBuildError("Unable to capture registry-emitted sha256 digest from docker push output");
  }
  return match[1];
}

function buildStaleFailureError(failures: StaleBuildFailure[]): DevcontainerImageBuildError {
  const details = failures.map(({ repo, error }) => {
    return `- ${repo.slug} (${repo.owner}/${repo.name}): ${errorMessage(error)}`;
  });
  return new DevcontainerImageBuildError(
    [`Failed to poll/build ${failures.length} tracked devcontainer repo(s):`, ...details].join("\n"),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitize(text: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => {
    if (!secret) {
      return current;
    }
    return current.split(secret).join("[redacted]");
  }, text);
}

function resolveLocalBin(repoRoot: string, name: string): string {
  return path.join(repoRoot, "node_modules", ".bin", name);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readArgValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new DevcontainerImageBuildError(`${name} requires a value`);
  }
  return value;
}

function helpText(): string {
  return [
    "Usage:",
    "  npm run build:devcontainer -- --repo <slug> [--sha <commitSha>]",
    "  npm run build:devcontainer -- --stale",
    "  npm run build:devcontainer -- --all [--use-manifest-sha]",
  ].join("\n");
}
