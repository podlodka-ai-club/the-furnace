// Workflow-safe primitives only — this module is reachable from the workflow
// bundle (via dispatch.ts), so it MUST NOT import Node APIs (`node:fs`,
// `node:path`, etc.). Registry loading and validation live in
// `repo-registry.ts`, which the orchestrator's `validateRepoSlug` activity
// imports.

const REPO_SLUG_BRAND = Symbol("RepoSlug");

export type RepoSlug = string & { readonly [REPO_SLUG_BRAND]: true };

export function taskQueueForRepo(slug: string): string {
  if (!slug) {
    throw new Error("taskQueueForRepo requires a non-empty slug");
  }
  return `repo-${slug}-worker`;
}
