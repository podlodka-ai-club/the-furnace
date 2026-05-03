import { describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import {
  GITHUB_FAILURE_TYPES,
  openPullRequestActivity,
  type OpenPullRequestInput,
} from "../../src/temporal/activities/github.js";
import type { GitHubClient } from "../../src/github/client.js";
import { validImplementationPlan } from "../agents/contracts/fixtures.js";

function makeInput(overrides: Partial<OpenPullRequestInput> = {}): OpenPullRequestInput {
  return {
    featureBranch: "agent/eng-5",
    targetRepoSlug: "test-repo",
    ticket: {
      id: "issue_5",
      identifier: "ENG-5",
      title: "Add export to CSV",
      description: "Users want to export their data.",
    },
    workflowId: "ticket-issue_5",
    attemptCount: 1,
    finalCommitSha: "f".repeat(40),
    diffSummary: "2 files changed, +7/-1",
    implementationPlan: validImplementationPlan,
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
  pullsCreate: ReturnType<typeof vi.fn>;
  pullsList: ReturnType<typeof vi.fn>;
}

function makeMockClient(opts: {
  createImpl?: (...args: unknown[]) => unknown;
  listImpl?: (...args: unknown[]) => unknown;
}): MockClient {
  const pullsCreate = vi.fn(opts.createImpl);
  const pullsList = vi.fn(opts.listImpl);
  const client = {
    pulls: { create: pullsCreate, list: pullsList },
  } as unknown as GitHubClient;
  return { client, pullsCreate, pullsList };
}

describe("openPullRequestActivity", () => {
  it("returns { number, url } from the create response on a fresh PR", async () => {
    const mock = makeMockClient({
      createImpl: async () => ({
        data: { number: 17, html_url: "https://github.test/Acme/service/pull/17" },
      }),
    });

    const result = await openPullRequestActivity(makeInput(), {
      createClient: () => mock.client,
      resolveToken: () => "token",
      resolveModel: () => "claude-test",
      resolveNamespace: () => "default",
      resolveWebBase: () => "http://localhost:8233",
      loadRegistry: async () => makeRegistry(),
    });

    expect(result).toEqual({
      number: 17,
      url: "https://github.test/Acme/service/pull/17",
    });
    expect(mock.pullsCreate).toHaveBeenCalledTimes(1);
    expect(mock.pullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "Acme",
        repo: "service",
        base: "main",
        head: "agent/eng-5",
        title: "ENG-5: Add export to CSV",
      }),
    );
  });

  it("returns the existing PR via list when create returns 422 'already exists'", async () => {
    const dupErr = Object.assign(new Error("Validation Failed: A pull request already exists"), {
      status: 422,
    });
    const mock = makeMockClient({
      createImpl: async () => {
        throw dupErr;
      },
      listImpl: async () => ({
        data: [{ number: 9, html_url: "https://github.test/Acme/service/pull/9" }],
      }),
    });

    const result = await openPullRequestActivity(makeInput(), {
      createClient: () => mock.client,
      resolveToken: () => "token",
      loadRegistry: async () => makeRegistry(),
    });

    expect(result).toEqual({
      number: 9,
      url: "https://github.test/Acme/service/pull/9",
    });
    expect(mock.pullsList).toHaveBeenCalledTimes(1);
    expect(mock.pullsList).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "Acme",
        repo: "service",
        base: "main",
        head: "Acme:agent/eng-5",
        state: "open",
      }),
    );
  });

  it("throws GitHubDuplicatePrNotFound when 422 surfaces but list finds nothing", async () => {
    const dupErr = Object.assign(new Error("Validation Failed: A pull request already exists"), {
      status: 422,
    });
    const mock = makeMockClient({
      createImpl: async () => {
        throw dupErr;
      },
      listImpl: async () => ({ data: [] }),
    });

    await expect(
      openPullRequestActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.duplicateNotFound,
      nonRetryable: true,
    });
  });

  it("throws GitHubAuthFailed (non-retryable) on 401", async () => {
    const authErr = Object.assign(new Error("Bad credentials"), { status: 401 });
    const mock = makeMockClient({
      createImpl: async () => {
        throw authErr;
      },
    });

    await expect(
      openPullRequestActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.authFailed,
      nonRetryable: true,
    });
  });

  it("throws GitHubHeadBranchMissing (non-retryable) when GitHub reports head missing", async () => {
    const err = Object.assign(new Error("Validation Failed: head branch does not exist"), {
      status: 422,
    });
    const mock = makeMockClient({
      createImpl: async () => {
        throw err;
      },
    });

    await expect(
      openPullRequestActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.headBranchMissing,
      nonRetryable: true,
    });
  });

  it("propagates 5xx as a retryable error (not an ApplicationFailure)", async () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const mock = makeMockClient({
      createImpl: async () => {
        throw err;
      },
    });

    await expect(
      openPullRequestActivity(makeInput(), {
        createClient: () => mock.client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toBe(err);
  });

  it("throws non-retryable token-missing failure when readGitHubToken throws", async () => {
    await expect(
      openPullRequestActivity(makeInput(), {
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
      openPullRequestActivity(makeInput({ targetRepoSlug: "nope" }), {
        createClient: () => makeMockClient({}).client,
        resolveToken: () => "token",
        loadRegistry: async () => makeRegistry(),
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.unknownRepoSlug,
      nonRetryable: true,
    });
  });

  it("throws non-retryable when registry entry is missing owner/name/ref", async () => {
    await expect(
      openPullRequestActivity(makeInput(), {
        createClient: () => makeMockClient({}).client,
        resolveToken: () => "token",
        loadRegistry: async () => [{ slug: "test-repo" }],
      }),
    ).rejects.toMatchObject({
      type: GITHUB_FAILURE_TYPES.registryEntryIncomplete,
      nonRetryable: true,
    });
  });

  it("uses the resolved model in the PR body metadata block", async () => {
    let receivedBody = "";
    const mock = makeMockClient({
      createImpl: async (args: unknown) => {
        receivedBody = (args as { body: string }).body;
        return {
          data: { number: 1, html_url: "https://github.test/Acme/service/pull/1" },
        };
      },
    });

    await openPullRequestActivity(makeInput(), {
      createClient: () => mock.client,
      resolveToken: () => "token",
      resolveModel: () => "claude-opus-4-7",
      loadRegistry: async () => makeRegistry(),
    });

    expect(receivedBody).toContain("Model: claude-opus-4-7");
    expect(receivedBody).toContain(`Final-Commit: ${"f".repeat(40)}`);
  });
});

// Sanity check that the failure-type constants are exported as ApplicationFailure-compatible strings.
describe("GITHUB_FAILURE_TYPES", () => {
  it("are non-empty strings usable as ApplicationFailure types", () => {
    for (const value of Object.values(GITHUB_FAILURE_TYPES)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      const failure = ApplicationFailure.nonRetryable("test", value);
      expect(failure.type).toBe(value);
    }
  });
});
