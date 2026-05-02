export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
export const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "the-furnace";

// Base URL for the Temporal Web UI, used to build deep links into specific
// workflow runs (e.g. embedded in `ac-clarification` Linear sub-tickets the
// spec agent opens). Default targets the local docker-compose dev UI.
export const TEMPORAL_WEB_BASE = process.env.TEMPORAL_WEB_BASE ?? "http://localhost:8233";

// Keep this conservative: a single Claude subscription is shared by all activities.
// Bounding local activity concurrency prevents one worker from self-starving the quota.
export const CLAUDE_ACTIVITY_CONCURRENCY = Number(process.env.CLAUDE_ACTIVITY_CONCURRENCY ?? 2);

// Default mount point inside per-attempt containers where the freshly cloned repo
// lives. Activities resolve their working directory through `readWorkerRepoPath`
// so test paths can override it via env without touching the container.
export const WORKER_REPO_PATH_DEFAULT = "/workspace";

export function readWorkerRepoPath(): string {
  const raw = process.env.WORKER_REPO_PATH;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  return WORKER_REPO_PATH_DEFAULT;
}

// Read at activity boundary (not module load) so a worker boots even when
// `TARGET_REPO_GITHUB_TOKEN` is not configured for environments that do not
// exercise the GitHub adapter. The github-pr-open activity throws a
// non-retryable ApplicationFailure when the token is missing.
export function readGitHubToken(): string {
  const raw = process.env.TARGET_REPO_GITHUB_TOKEN;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      "TARGET_REPO_GITHUB_TOKEN is not set. Configure a GitHub PAT (`repo` for private, `public_repo` for public) on the orchestrator worker.",
    );
  }
  return raw;
}

// Identifier embedded in the PR-body metadata block so the PR records which
// model produced the change. Falls back to the literal `unknown` when unset
// so deployments without explicit model pinning still emit a well-formed
// metadata block.
export function readClaudeModel(): string {
  const raw = process.env.CLAUDE_MODEL;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return "unknown";
  }
  return raw;
}

// Maximum corrective nudges the coder activity will send to the agent before
// giving up the attempt with a retryable failure. Default 3; override via env
// for tighter or looser budgets.
export function readCoderCorrectionBudget(): number {
  const raw = process.env.CODER_CORRECTION_BUDGET;
  if (raw === undefined || raw.trim().length === 0) {
    return 3;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `CODER_CORRECTION_BUDGET must be a positive integer, got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
