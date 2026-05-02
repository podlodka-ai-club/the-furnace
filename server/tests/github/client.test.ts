import { describe, expect, it } from "vitest";
import { classifyGitHubError } from "../../src/github/client.js";

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("classifyGitHubError", () => {
  it("classifies 401 as auth", () => {
    const result = classifyGitHubError(makeError(401, "Bad credentials"));
    expect(result.kind).toBe("auth");
    expect(result.status).toBe(401);
  });

  it("classifies 403 as auth", () => {
    const result = classifyGitHubError(makeError(403, "Forbidden"));
    expect(result.kind).toBe("auth");
    expect(result.status).toBe(403);
  });

  it("classifies 422 'pull request already exists' as duplicate", () => {
    const result = classifyGitHubError(
      makeError(422, "Validation Failed: A pull request already exists for owner:branch."),
    );
    expect(result.kind).toBe("duplicate");
    expect(result.status).toBe(422);
  });

  it("classifies 422 with no matching duplicate or head-missing message as other", () => {
    const result = classifyGitHubError(makeError(422, "Validation Failed: random other reason"));
    expect(result.kind).toBe("other");
    expect(result.status).toBe(422);
  });

  it("classifies 422 'head ... does not exist' as headMissing", () => {
    const result = classifyGitHubError(
      makeError(422, "Validation Failed: head branch does not exist"),
    );
    expect(result.kind).toBe("headMissing");
    expect(result.status).toBe(422);
  });

  it("classifies 5xx as transient", () => {
    expect(classifyGitHubError(makeError(500, "Internal Server Error")).kind).toBe("transient");
    expect(classifyGitHubError(makeError(502, "Bad Gateway")).kind).toBe("transient");
    expect(classifyGitHubError(makeError(503, "Service Unavailable")).kind).toBe("transient");
  });

  it("classifies network-style Error without status as transient", () => {
    const result = classifyGitHubError(new Error("ECONNRESET"));
    expect(result.kind).toBe("transient");
  });

  it("classifies non-error values as other", () => {
    const result = classifyGitHubError("just a string");
    expect(result.kind).toBe("other");
  });
});
