import {
  launchWorkerContainer as launchWorkerContainerImpl,
  type LaunchWorkerContainerInput,
  type LaunchWorkerContainerResult,
} from "../../worker-launcher.js";
import { assertRepoSlug, loadRepoSlugRegistry } from "../repo-registry.js";

export type {
  LaunchWorkerContainerInput,
  LaunchWorkerContainerResult,
};

export async function launchWorkerContainer(
  input: LaunchWorkerContainerInput,
): Promise<LaunchWorkerContainerResult> {
  return await launchWorkerContainerImpl(input);
}

export interface ValidateRepoSlugInput {
  slug: string;
}

// Reads build/repos.json on the orchestrator host and throws if the slug isn't
// registered. Surfaces as an ApplicationFailure (`UnknownRepoSlugError`) which
// the workflow rethrows as a non-retryable failure before any container
// launch.
export async function validateRepoSlug(input: ValidateRepoSlugInput): Promise<void> {
  const registry = await loadRepoSlugRegistry();
  assertRepoSlug(input.slug, registry);
}
