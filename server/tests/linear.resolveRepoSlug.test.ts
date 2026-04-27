import { describe, expect, it } from "vitest";
import { resolveRepoSlugFromLabels } from "../src/linear/resolveRepoSlug.js";

const REGISTRY = new Set(["foo", "bar", "demo"]);

describe("resolveRepoSlugFromLabels", () => {
  it("returns missing_repo_label when no labels are present", () => {
    expect(resolveRepoSlugFromLabels([], REGISTRY)).toEqual({
      ok: false,
      reason: "missing_repo_label",
    });
  });

  it("returns missing_repo_label when only unrelated labels are present", () => {
    expect(
      resolveRepoSlugFromLabels(
        [{ name: "agent-ready" }, { name: "bug" }, { name: "priority-high" }],
        REGISTRY,
      ),
    ).toEqual({ ok: false, reason: "missing_repo_label" });
  });

  it("resolves a single matching repo label", () => {
    expect(
      resolveRepoSlugFromLabels(
        [{ name: "agent-ready" }, { name: "repo:foo" }],
        REGISTRY,
      ),
    ).toEqual({ ok: true, slug: "foo" });
  });

  it("returns unknown_repo_slug when the candidate slug is not in the registry", () => {
    expect(
      resolveRepoSlugFromLabels([{ name: "repo:nope" }], REGISTRY),
    ).toEqual({
      ok: false,
      reason: "unknown_repo_slug",
      offending: "nope",
    });
  });

  it("returns ambiguous_repo_label when multiple repo: labels are present", () => {
    expect(
      resolveRepoSlugFromLabels(
        [{ name: "repo:foo" }, { name: "repo:bar" }],
        REGISTRY,
      ),
    ).toEqual({ ok: false, reason: "ambiguous_repo_label" });
  });

  it("rejects mixed-case prefixes (e.g. Repo:)", () => {
    expect(
      resolveRepoSlugFromLabels([{ name: "Repo:foo" }], REGISTRY),
    ).toEqual({ ok: false, reason: "missing_repo_label" });
  });

  it("rejects whitespace after the prefix (e.g. 'repo: foo')", () => {
    expect(
      resolveRepoSlugFromLabels([{ name: "repo: foo" }], REGISTRY),
    ).toEqual({ ok: false, reason: "missing_repo_label" });
  });

  it("ignores non-`repo:` labels entirely when resolving", () => {
    expect(
      resolveRepoSlugFromLabels(
        [
          { name: "agent-ready" },
          { name: "bug" },
          { name: "priority-high" },
          { name: "repo:demo" },
        ],
        REGISTRY,
      ),
    ).toEqual({ ok: true, slug: "demo" });
  });
});
