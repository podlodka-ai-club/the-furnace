import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_FAILURE_TYPES,
  postPullRequestReviewActivity,
  type PostPullRequestReviewInput,
} from "../../src/temporal/activities/github.js";
import type { GitHubClient } from "../../src/github/client.js";

function makeInput(
  overrides: Partial<PostPullRequestReviewInput> = {},
): PostPullRequestReviewInput {
  return {
    targetRepoSlug: "test-repo",
    prNumber: 17,
    verdict: "approve",
    body: "Looks good.",
    comments: [],
    ...overrides,
  };
}

function makeRegistry() {
  return [
    {
      slug: "test-repo",
      owner: "Acme",
      name: "service",
      ref: "main",
    },
  ];
}

interface MockClient {
  client: GitHubClient;
  pullsCreateReview: ReturnType<typeof vi.fn>;
}

function makeMockClient(opts: { createReviewImpl?: (...args: unknown[]) => unknown }): MockClient {
  const pullsCreateReview = vi.fn(opts.createReviewImpl);
  const client = {
    pulls: { createReview: pullsCreateReview },
  } as unknown as GitHubClient;
  return { client, pullsCreateReview };
}

describe("postPullRequestReviewActivity", () => {
  it("posts the review with event COMMENT regardless of verdict and forwards comments", async () => {
    const mock = makeMockClient({
      createReviewImpl: async () => ({ data: { id: 99 } }),
    });

    const result = await postPullRequestReviewActivity(
      makeInput({
        verdict: "approve",
        body: "All good.",
        comments: [
          { path: "src/foo.ts", line: 12, body: "[advisory] Consider rename" },
          { path: "src/bar.ts", body: "[advisory] Style nit" },
        ],
      }),
      {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      },
    );

    expect(result).toEqual({ reviewId: 99, droppedComments: 0 });
    expect(mock.pullsCreateReview).toHaveBeenCalledTimes(1);
    expect(mock.pullsCreateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "Acme",
        repo: "service",
        pull_number: 17,
        event: "COMMENT",
        body: "All good.",
        comments: [
          { path: "src/foo.ts", body: "[advisory] Consider rename", line: 12, side: "RIGHT" },
          { path: "src/bar.ts", body: "[advisory] Style nit" },
        ],
      }),
    );
  });

  it("uses event COMMENT for verdict 'changes_requested' as well", async () => {
    const mock = makeMockClient({
      createReviewImpl: async () => ({ data: { id: 100 } }),
    });

    await postPullRequestReviewActivity(
      makeInput({ verdict: "changes_requested", body: "Issues remain." }),
      {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      },
    );

    expect(mock.pullsCreateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "COMMENT",
        body: "Issues remain.",
      }),
    );
  });

  it("retries with empty comments when GitHub returns 422 stale-line and reports droppedComments", async () => {
    const staleErr = Object.assign(
      new Error("Validation Failed: line is not part of the diff"),
      { status: 422 },
    );
    let calls = 0;
    const mock = makeMockClient({
      createReviewImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw staleErr;
        }
        return { data: { id: 222 } };
      },
    });

    const result = await postPullRequestReviewActivity(
      makeInput({
        verdict: "changes_requested",
        comments: [
          { path: "src/foo.ts", line: 1234, body: "[blocking] Stale line" },
          { path: "src/bar.ts", body: "[advisory] No line" },
        ],
      }),
      {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      },
    );

    expect(result).toEqual({ reviewId: 222, droppedComments: 2 });
    expect(mock.pullsCreateReview).toHaveBeenCalledTimes(2);
    const secondCall = mock.pullsCreateReview.mock.calls[1][0] as { comments: unknown[] };
    expect(secondCall.comments).toEqual([]);
  });

  it("retries with empty comments when GitHub returns 422 \"Path could not be resolved\"", async () => {
    const pathErr = Object.assign(
      new Error(
        'Unprocessable Entity: "Path could not be resolved, Path could not be resolved, and Path could not be resolved"',
      ),
      { status: 422 },
    );
    let calls = 0;
    const mock = makeMockClient({
      createReviewImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw pathErr;
        }
        return { data: { id: 333 } };
      },
    });

    const result = await postPullRequestReviewActivity(
      makeInput({
        verdict: "changes_requested",
        comments: [
          { path: "renamed/old.ts", line: 1, body: "[blocking] Path gone" },
          { path: "deleted.ts", line: 2, body: "[blocking] File deleted" },
          { path: "moved/new.ts", body: "[advisory] Path moved" },
        ],
      }),
      {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      },
    );

    expect(result).toEqual({ reviewId: 333, droppedComments: 3 });
    expect(mock.pullsCreateReview).toHaveBeenCalledTimes(2);
    const secondCall = mock.pullsCreateReview.mock.calls[1][0] as { comments: unknown[] };
    expect(secondCall.comments).toEqual([]);
  });

  it("throws GitHubAuthFailed (non-retryable) on 401", async () => {
    const authErr = Object.assign(new Error("Bad credentials"), { status: 401 });
    const mock = makeMockClient({
      createReviewImpl: async () => {
        throw authErr;
      },
    });

    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.authFailed,
      nonRetryable: true,
    });
  });

  it("throws GitHubAuthFailed (non-retryable) on 403", async () => {
    const forbiddenErr = Object.assign(new Error("Forbidden"), { status: 403 });
    const mock = makeMockClient({
      createReviewImpl: async () => {
        throw forbiddenErr;
      },
    });

    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.authFailed,
      nonRetryable: true,
    });
  });

  it("throws GitHubPullRequestMissing (non-retryable) on 404", async () => {
    const notFoundErr = Object.assign(new Error("Not Found"), { status: 404 });
    const mock = makeMockClient({
      createReviewImpl: async () => {
        throw notFoundErr;
      },
    });

    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.pullRequestMissing,
      nonRetryable: true,
    });
  });

  it("propagates 5xx as a retryable error (not an ApplicationFailure)", async () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const mock = makeMockClient({
      createReviewImpl: async () => {
        throw err;
      },
    });

    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toBe(err);
  });

  it("throws GitHubReviewRejected (non-retryable) on a non-stale-line 422", async () => {
    const err = Object.assign(new Error("Validation Failed: review event is invalid"), {
      status: 422,
    });
    const mock = makeMockClient({
      createReviewImpl: async () => {
        throw err;
      },
    });

    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.reviewRejected,
      nonRetryable: true,
    });
  });

  it("throws non-retryable token-missing failure when readGitHubToken throws", async () => {
    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => makeMockClient({}).client,
        resolveToken: () => {
          throw new Error("TARGET_REPO_GITHUB_TOKEN is not set");
        },
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.tokenMissing,
      nonRetryable: true,
    });
  });

  it("throws non-retryable for unknown repo slug", async () => {
    await expect(
      postPullRequestReviewActivity(makeInput({ targetRepoSlug: "nope" }), {
        createClient: () => makeMockClient({}).client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.unknownRepoSlug,
      nonRetryable: true,
    });
  });

  it("throws non-retryable when registry entry is missing owner/name", async () => {
    await expect(
      postPullRequestReviewActivity(makeInput(), {
        createClient: () => makeMockClient({}).client,
        resolveToken: () => "token",
        loadRegistry: async () => [
          { slug: "test-repo", owner: "", name: "", ref: "main" },
        ],
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.registryEntryIncomplete,
      nonRetryable: true,
    });
  });
});
