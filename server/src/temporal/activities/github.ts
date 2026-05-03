import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";
import { reviewerTicketSchema } from "../../agents/contracts/reviewer-io.js";
import { implementationPlanSchema } from "../../agents/contracts/spec-output.js";
import { buildWorkflowDeepLink } from "../../agents/coder/activity.js";
import {
  classifyGitHubError,
  createGitHubClient,
  findOpenPR,
  openPR,
  postReview,
  type GitHubClient,
  type PostReviewResult,
  type PullRequestRef,
  type ReviewCommentInput,
  type ReviewEvent,
} from "../../github/client.js";
import { buildPrBody, buildPrTitle } from "../../github/trailers.js";
import {
  findRegistryEntry,
  loadRepoSlugRegistry,
  type RepoSlugRegistryEntry,
} from "../repo-registry.js";
import {
  TEMPORAL_NAMESPACE,
  TEMPORAL_WEB_BASE,
  readClaudeModel,
  readGitHubToken,
} from "../config.js";

export const GITHUB_FAILURE_TYPES = {
  authFailed: "GitHubAuthFailed",
  headBranchMissing: "GitHubHeadBranchMissing",
  unknownRepoSlug: "GitHubUnknownRepoSlug",
  registryEntryIncomplete: "GitHubRegistryEntryIncomplete",
  duplicateNotFound: "GitHubDuplicatePrNotFound",
  tokenMissing: "GitHubTokenMissing",
  badResponse: "GitHubBadResponse",
  pullRequestMissing: "GitHubPullRequestMissing",
  reviewRejected: "GitHubReviewRejected",
} as const;

export const openPullRequestInputSchema = z.object({
  featureBranch: z.string().min(1),
  targetRepoSlug: z.string().min(1),
  ticket: reviewerTicketSchema,
  workflowId: z.string().min(1),
  attemptCount: z.number().int().nonnegative(),
  finalCommitSha: z.string().min(1),
  diffSummary: z.string().min(1),
  implementationPlan: implementationPlanSchema,
});

export type OpenPullRequestInput = z.infer<typeof openPullRequestInputSchema>;

export interface OpenPullRequestResult {
  number: number;
  url: string;
}

export interface OpenPullRequestActivityDeps {
  createClient?: (token: string) => GitHubClient;
  resolveToken?: () => string;
  resolveModel?: () => string;
  resolveNamespace?: () => string;
  resolveWebBase?: () => string;
  loadRegistry?: () => Promise<RepoSlugRegistryEntry[]>;
}

export async function openPullRequestActivity(
  input: OpenPullRequestInput,
  deps: OpenPullRequestActivityDeps = {},
): Promise<OpenPullRequestResult> {
  const validated = openPullRequestInputSchema.parse(input);

  const registry = await (deps.loadRegistry ?? loadRepoSlugRegistry)();
  const entry = findRegistryEntry(registry, validated.targetRepoSlug);
  if (!entry) {
    throw ApplicationFailure.nonRetryable(
      `Unknown targetRepoSlug '${validated.targetRepoSlug}' — not present in repo registry`,
      GITHUB_FAILURE_TYPES.unknownRepoSlug,
    );
  }
  if (!entry.owner || !entry.name || !entry.ref) {
    throw ApplicationFailure.nonRetryable(
      `Repo registry entry for '${validated.targetRepoSlug}' is missing one of owner/name/ref required for PR open`,
      GITHUB_FAILURE_TYPES.registryEntryIncomplete,
    );
  }

  const token = resolveToken(deps.resolveToken);
  const client = (deps.createClient ?? createGitHubClient)(token);

  const namespace = (deps.resolveNamespace ?? (() => TEMPORAL_NAMESPACE))();
  const webBase = (deps.resolveWebBase ?? (() => TEMPORAL_WEB_BASE))();
  const model = (deps.resolveModel ?? readClaudeModel)();

  const title = buildPrTitle(validated.ticket.identifier, validated.ticket.title);
  const workflowDeepLink = buildWorkflowDeepLink(webBase, namespace, validated.workflowId);
  const body = buildPrBody({
    ticketDescription: validated.ticket.description ?? "",
    implementationPlan: validated.implementationPlan,
    diffSummary: validated.diffSummary,
    workflowDeepLink,
    metadata: {
      workflowId: validated.workflowId,
      ticketId: validated.ticket.id,
      ticketIdentifier: validated.ticket.identifier,
      attemptCount: validated.attemptCount,
      model,
      finalCommit: validated.finalCommitSha,
    },
  });

  const openArgs = {
    owner: entry.owner,
    repo: entry.name,
    base: entry.ref,
    head: validated.featureBranch,
    title,
    body,
  };

  let created: PullRequestRef;
  try {
    created = await openPR(client, openArgs);
    return created;
  } catch (err) {
    const classified = classifyGitHubError(err);
    if (classified.kind === "auth") {
      throw ApplicationFailure.nonRetryable(
        `GitHub rejected authentication while opening PR for ${validated.targetRepoSlug}`,
        GITHUB_FAILURE_TYPES.authFailed,
      );
    }
    if (classified.kind === "headMissing") {
      throw ApplicationFailure.nonRetryable(
        `GitHub reports head branch '${validated.featureBranch}' is not present on ${entry.owner}/${entry.name}`,
        GITHUB_FAILURE_TYPES.headBranchMissing,
      );
    }
    if (classified.kind === "duplicate") {
      const existing = await findOpenPR(client, {
        owner: entry.owner,
        repo: entry.name,
        base: entry.ref,
        head: validated.featureBranch,
      });
      if (!existing) {
        throw ApplicationFailure.nonRetryable(
          `GitHub returned 422 for duplicate PR but no matching open PR was found for head '${entry.owner}:${validated.featureBranch}' base '${entry.ref}'`,
          GITHUB_FAILURE_TYPES.duplicateNotFound,
        );
      }
      return existing;
    }
    // Transient + other → propagate as-is so Temporal's default retry policy
    // either retries (network/5xx) or surfaces the underlying error verbatim.
    throw err;
  }
}

function resolveToken(override?: () => string): string {
  const reader = override ?? readGitHubToken;
  try {
    return reader();
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      err instanceof Error ? err.message : String(err),
      GITHUB_FAILURE_TYPES.tokenMissing,
    );
  }
}

const reviewVerdictForActivitySchema = z.enum(["approve", "changes_requested"]);

export const postPullRequestReviewInputSchema = z.object({
  targetRepoSlug: z.string().min(1),
  prNumber: z.number().int().positive(),
  verdict: reviewVerdictForActivitySchema,
  body: z.string().min(1),
  comments: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive().optional(),
        body: z.string().min(1),
      }),
    )
    .default([]),
});

export type PostPullRequestReviewInput = z.infer<typeof postPullRequestReviewInputSchema>;

export interface PostPullRequestReviewResult {
  reviewId: number;
  droppedComments: number;
}

export interface PostPullRequestReviewDeps {
  createClient?: (token: string) => GitHubClient;
  resolveToken?: () => string;
  loadRegistry?: () => Promise<RepoSlugRegistryEntry[]>;
}

export async function postPullRequestReviewActivity(
  input: PostPullRequestReviewInput,
  deps: PostPullRequestReviewDeps = {},
): Promise<PostPullRequestReviewResult> {
  const validated = postPullRequestReviewInputSchema.parse(input);

  const registry = await (deps.loadRegistry ?? loadRepoSlugRegistry)();
  const entry = findRegistryEntry(registry, validated.targetRepoSlug);
  if (!entry) {
    throw ApplicationFailure.nonRetryable(
      `Unknown targetRepoSlug '${validated.targetRepoSlug}' — not present in repo registry`,
      GITHUB_FAILURE_TYPES.unknownRepoSlug,
    );
  }
  if (!entry.owner || !entry.name) {
    throw ApplicationFailure.nonRetryable(
      `Repo registry entry for '${validated.targetRepoSlug}' is missing one of owner/name required for PR review post`,
      GITHUB_FAILURE_TYPES.registryEntryIncomplete,
    );
  }

  const token = resolveToken(deps.resolveToken);
  const client = (deps.createClient ?? createGitHubClient)(token);

  // Single-identity setup: the same GitHub PAT that opens the PR also posts
  // the review, and GitHub forbids APPROVE/REQUEST_CHANGES on your own PR.
  // Always emit COMMENT — the verdict (`approve` / `changes_requested`) is
  // preserved in the workflow output and the PR-body trailer for downstream
  // consumers (vote-aggregator, auto-merge). When multi-persona review with
  // a separate reviewer identity lands, that proposal can re-introduce the
  // verdict→event mapping.
  const event: ReviewEvent = "COMMENT";
  const comments: ReviewCommentInput[] = validated.comments.map((c) => ({
    path: c.path,
    body: c.body,
    ...(c.line !== undefined ? { line: c.line } : {}),
  }));

  try {
    const result = await postReview(client, {
      owner: entry.owner,
      repo: entry.name,
      pullNumber: validated.prNumber,
      event,
      body: validated.body,
      comments,
    });
    return { reviewId: result.reviewId, droppedComments: 0 };
  } catch (err) {
    const classified = classifyGitHubError(err);
    if (classified.kind === "auth") {
      throw ApplicationFailure.nonRetryable(
        `GitHub rejected authentication while posting PR review for ${validated.targetRepoSlug}#${validated.prNumber}`,
        GITHUB_FAILURE_TYPES.authFailed,
      );
    }
    if (classified.kind === "notFound") {
      throw ApplicationFailure.nonRetryable(
        `GitHub reports PR #${validated.prNumber} on ${entry.owner}/${entry.name} does not exist`,
        GITHUB_FAILURE_TYPES.pullRequestMissing,
      );
    }
    if (classified.kind === "staleLine") {
      const droppedPaths = comments.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}`);
      console.warn(
        `[postPullRequestReview] dropping ${comments.length} inline comment(s) due to stale-line 422; retrying with no inline comments. Dropped: ${droppedPaths.join(", ")}`,
      );
      const fallback: PostReviewResult = await postReview(client, {
        owner: entry.owner,
        repo: entry.name,
        pullNumber: validated.prNumber,
        event,
        body: validated.body,
        comments: [],
      });
      return { reviewId: fallback.reviewId, droppedComments: comments.length };
    }
    if (classified.status === 422) {
      throw ApplicationFailure.nonRetryable(
        `GitHub rejected the PR review for ${validated.targetRepoSlug}#${validated.prNumber}: ${err instanceof Error ? err.message : String(err)}`,
        GITHUB_FAILURE_TYPES.reviewRejected,
      );
    }
    // 5xx, transient, network → propagate as-is so Temporal retries.
    throw err;
  }
}
