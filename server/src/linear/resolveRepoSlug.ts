export type RepoSlugResolution =
  | { ok: true; slug: string }
  | {
      ok: false;
      reason: "missing_repo_label" | "ambiguous_repo_label" | "unknown_repo_slug";
      offending?: string;
    };

const REPO_LABEL_PREFIX = "repo:";

// Resolves the target repo slug from a Linear ticket's labels.
//
// Rules (per spec):
// - Labels are matched exactly and case-sensitively against the prefix `repo:`
//   (so `Repo:foo` and `repo: foo` (note the space) are NOT matched).
// - Exactly one matching label is required.
// - The candidate slug (substring after `repo:`) must exist in the registry.
export function resolveRepoSlugFromLabels(
  labels: ReadonlyArray<{ name: string }>,
  registry: ReadonlySet<string>,
): RepoSlugResolution {
  const matches: string[] = [];
  for (const label of labels) {
    if (typeof label.name !== "string") {
      continue;
    }
    if (!label.name.startsWith(REPO_LABEL_PREFIX)) {
      continue;
    }
    const candidate = label.name.slice(REPO_LABEL_PREFIX.length);
    // The pattern requires no whitespace tolerance; a label like `repo: foo`
    // yields candidate ` foo` and is rejected as not in the registry. But the
    // spec also says `repo: foo` should not match at all — treat any candidate
    // that starts with whitespace as a non-match.
    if (candidate.length === 0 || /^\s/.test(candidate)) {
      continue;
    }
    matches.push(candidate);
  }

  if (matches.length === 0) {
    return { ok: false, reason: "missing_repo_label" };
  }

  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous_repo_label" };
  }

  const candidate = matches[0];
  if (!registry.has(candidate)) {
    return { ok: false, reason: "unknown_repo_slug", offending: candidate };
  }

  return { ok: true, slug: candidate };
}
