## Context

The `devcontainer-image-build` capability was archived at `openspec/specs/devcontainer-image-build/spec.md` with two requirements that anchor `build/repos.json` and `build/<slug>/manifest.json` as committed-to-git artifacts:

- "Tracked repos are listed in build/repos.json" — implies the file is the committed source of truth.
- "Build manifest is the producer/consumer contract surface" — explicitly requires the manual CI workflow to commit `manifest.json` back to `main`.

Commit `f1d108f` (Add spec agent) shipped a different model: `build/repos.json` was renamed to `build/repos.example.json`, and `.gitignore` now excludes `build/*` except the example. The reasons aren't in the commit message but are easy to infer — committed `repos.json` couples the-furnace to a single deployment's tracked-repo set, and committed `manifest.json` files cause merge churn whenever an image is rebuilt locally. Per-install local config is the simpler shape for an early-stage tool with one or two operators.

This is a mostly-retroactive reconciliation. The shipped behavior under the new gitignore matches the new spec, so most of the code is already correct. One coherence gap remains: `.github/workflows/build-devcontainer-images.yml` still has a "Commit manifest update" step left over from `c98f2a0`. Under the new gitignore that step is unreachable (manifests are excluded), but its presence still encodes the old intent — committing manifests to `main` — which contradicts the new spec. We delete the step as part of this change so the workflow stops carrying dead intent.

## Goals / Non-Goals

**Goals:**
- The `devcontainer-image-build` spec accurately reflects shipped behavior: `repos.json` and `manifest.json` are local-per-install, and CI does not commit manifests back to `main`.
- The runtime contract surface (build script, workflow, orchestrator all read `build/repos.json` and `build/<slug>/manifest.json` from the local install) stays unchanged in spirit — only the file's lifecycle is restated.
- A committed example template (`build/repos.example.json`) is the documented onboarding entry point.

**Non-Goals:**
- No build-script changes. The build script still reads `build/repos.json` and writes `build/<slug>/manifest.json` from/to the local working tree, which already matches the new spec.
- No broader workflow rewrite. The only workflow edit is deleting the dead commit step (and not, e.g., reworking permissions, registry auth, or the trigger surface). If `f1d108f` introduced any *behavioral* drift beyond file lifecycle and this one workflow step, that is out of scope here and should get its own change.
- No new mechanism for distributing tracked-repo config across installs (e.g., a remote registry, env-var-driven config). If that becomes necessary it's a separate proposal.
- No archival of the existing spec. We're modifying it via delta, not replacing it.

## Decisions

**Decision: MODIFIED, not REMOVED, for both affected requirements.**
The requirements still exist — `build/repos.json` is still the runtime config file, and `manifest.json` is still the producer/consumer contract surface. Only the lifecycle (committed vs. local) and the CI commit-back scenario change. MODIFIED preserves the rest of the requirement intact (slug normalization rules, manifest field set, credential exclusion, etc.) without re-listing every scenario as ADDED/REMOVED.

Alternative considered: REMOVED + ADDED pair. Rejected — it would force re-stating all the surrounding scenarios (manifest field set, missing-config behavior) that haven't changed, and would lose the audit trail of what was modified vs. what stayed.

**Decision: Drop the "Manual workflow commits manifest back to main on success" scenario entirely rather than restate it as a no-op.**
The CI commit-back is no longer desired behavior; keeping a softened version of it ("workflow MAY commit if configured") would invite future drift. Cleaner to remove the scenario in the MODIFIED block.

**Decision: tasks.md is mostly verification, with one small implementation step (delete the workflow's commit step).**
The change is "make spec match reality." Most of reality already matches; the workflow step is the one piece that still encoded the old intent. Surfaced by `/opsx:verify` and folded into tasks.md as a single step rather than spun out into a separate change, since the edit is small (delete a single step in one file) and tightly coupled to the spec delta — splitting it would create a chicken-and-egg ordering between the spec change and the workflow change.

## Risks / Trade-offs

- **[Risk]** Future operators bringing up a new install have no committed `repos.json` to crib from. → **Mitigation**: `build/repos.example.json` is committed and serves as the template; the spec delta will reference it explicitly.
- **[Risk]** A new deployment forgets to set `TARGET_REPO_GITHUB_TOKEN`-scoped repos in their local `repos.json` and the orchestrator silently has nothing to track. → **Mitigation**: out of scope here — the existing "Repository slug normalization" and Linear `repo:<slug>` resolution requirements already handle missing-repo errors at runtime. If onboarding-time validation is needed it's a separate change.
- **[Trade-off]** Losing the auditable, in-git history of which image digest was deployed when. → Accepted: in early-stage operation this audit value is low, and the registry itself retains digest history. If/when this becomes a real ops concern, `provenance-store` is the natural home.
