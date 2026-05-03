import { Octokit } from "@octokit/rest";

export type GitHubClient = Octokit;

export function createGitHubClient(token: string): GitHubClient {
  return new Octokit({ auth: token });
}

export interface OpenPRArgs {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

export async function openPR(client: GitHubClient, args: OpenPRArgs): Promise<PullRequestRef> {
  const response = await client.pulls.create({
    owner: args.owner,
    repo: args.repo,
    base: args.base,
    head: args.head,
    title: args.title,
    body: args.body,
  });
  return { number: response.data.number, url: response.data.html_url };
}

export interface FindOpenPRArgs {
  owner: string;
  repo: string;
  base: string;
  head: string;
}

export async function findOpenPR(
  client: GitHubClient,
  args: FindOpenPRArgs,
): Promise<PullRequestRef | null> {
  const response = await client.pulls.list({
    owner: args.owner,
    repo: args.repo,
    state: "open",
    head: `${args.owner}:${args.head}`,
    base: args.base,
    per_page: 1,
  });
  const first = response.data[0];
  if (!first) {
    return null;
  }
  return { number: first.number, url: first.html_url };
}

export type ReviewEvent = "COMMENT";

export interface ReviewCommentInput {
  path: string;
  line?: number;
  body: string;
}

export interface PostReviewArgs {
  owner: string;
  repo: string;
  pullNumber: number;
  event: ReviewEvent;
  body: string;
  comments: ReadonlyArray<ReviewCommentInput>;
}

export interface PostReviewResult {
  reviewId: number;
}

export async function postReview(
  client: GitHubClient,
  args: PostReviewArgs,
): Promise<PostReviewResult> {
  const response = await client.pulls.createReview({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
    event: args.event,
    body: args.body,
    comments: args.comments.map((c) => ({
      path: c.path,
      body: c.body,
      ...(c.line !== undefined ? { line: c.line, side: "RIGHT" as const } : {}),
    })),
  });
  return { reviewId: response.data.id };
}

export type GitHubErrorKind =
  | "auth"
  | "headMissing"
  | "duplicate"
  | "transient"
  | "notFound"
  | "staleLine"
  | "other";

export interface ClassifiedGitHubError {
  kind: GitHubErrorKind;
  status?: number;
  original: unknown;
}

// `head branch ... does not exist` and `A pull request already exists` both
// arrive as 422 Validation Failed. We disambiguate on the message so the
// activity can react appropriately (retryable vs. fetch-existing vs. fail).
export function classifyGitHubError(err: unknown): ClassifiedGitHubError {
  const status = readStatus(err);
  const message = readMessage(err).toLowerCase();

  if (status === 401 || status === 403) {
    return { kind: "auth", status, original: err };
  }

  if (status === 404) {
    return { kind: "notFound", status, original: err };
  }

  if (status === 422) {
    if (
      message.includes("head") &&
      (message.includes("does not exist") || message.includes("not exist") || message.includes("invalid"))
    ) {
      return { kind: "headMissing", status, original: err };
    }
    if (message.includes("already exists") || message.includes("a pull request already exists")) {
      return { kind: "duplicate", status, original: err };
    }
    if (
      ((message.includes("line") || message.includes("position")) &&
        (message.includes("diff") || message.includes("not part") || message.includes("invalid"))) ||
      message.includes("path could not be resolved")
    ) {
      return { kind: "staleLine", status, original: err };
    }
    return { kind: "other", status, original: err };
  }

  if (typeof status === "number" && status >= 500 && status < 600) {
    return { kind: "transient", status, original: err };
  }

  if (status === undefined && err instanceof Error) {
    return { kind: "transient", original: err };
  }

  return { kind: "other", status, original: err };
}

function readStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}
