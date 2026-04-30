import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { RepoSlug } from "./repo-slug.js";

export class UnknownRepoSlugError extends Error {
  readonly slug: string;

  constructor(slug: string, knownSlugs: readonly string[]) {
    const known = knownSlugs.length > 0 ? knownSlugs.join(", ") : "<none>";
    super(`Unknown repo slug '${slug}'. Known slugs: ${known}`);
    this.name = "UnknownRepoSlugError";
    this.slug = slug;
  }
}

export interface RepoSlugRegistryEntry {
  slug: string;
  languages?: string[];
  tools?: string[];
}

interface RawRepoEntry {
  slug?: unknown;
  languages?: unknown;
  tools?: unknown;
}

function defaultReposPath(repoRoot: string): string {
  return path.join(repoRoot, "build", "repos.json");
}

function resolveDefaultRepoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

export async function loadRepoSlugRegistry(
  repoRoot: string = resolveDefaultRepoRoot(),
): Promise<RepoSlugRegistryEntry[]> {
  const reposPath = defaultReposPath(repoRoot);
  const raw = await readFile(reposPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${reposPath} must contain an array of repo entries`);
  }
  return parsed.map((entry) => normalizeRegistryEntry(entry));
}

function normalizeRegistryEntry(entry: unknown): RepoSlugRegistryEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("Each repo entry must be an object");
  }
  const raw = entry as RawRepoEntry;
  if (typeof raw.slug !== "string" || raw.slug.length === 0) {
    throw new Error("Each repo entry must have a non-empty 'slug' string");
  }
  const languages = Array.isArray(raw.languages)
    ? raw.languages.filter((v): v is string => typeof v === "string")
    : undefined;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((v): v is string => typeof v === "string")
    : undefined;
  return { slug: raw.slug, languages, tools };
}

export function assertRepoSlug(value: string, registry: RepoSlugRegistryEntry[]): RepoSlug {
  const knownSlugs = registry.map((entry) => entry.slug);
  if (!knownSlugs.includes(value)) {
    throw new UnknownRepoSlugError(value, knownSlugs);
  }
  return value as RepoSlug;
}

export async function resolveRepoSlug(
  value: string,
  repoRoot: string = resolveDefaultRepoRoot(),
): Promise<RepoSlug> {
  const registry = await loadRepoSlugRegistry(repoRoot);
  return assertRepoSlug(value, registry);
}

export function findRegistryEntry(
  registry: RepoSlugRegistryEntry[],
  slug: string,
): RepoSlugRegistryEntry | undefined {
  return registry.find((entry) => entry.slug === slug);
}
