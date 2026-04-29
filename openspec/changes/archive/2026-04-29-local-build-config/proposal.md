## Why

The archived `devcontainer-image-build` spec mandates that `build/repos.json` and `build/<slug>/manifest.json` are committed to the repo (with CI committing manifests back to `main`). Implementation has since diverged: commit `f1d108f` renamed `build/repos.json` → `build/repos.example.json` and gitignored `build/*`, making the build config local-per-install. This retroactive change reconciles the spec with shipped reality so future agents don't keep proposing to "fix" the now-correct gitignore.

## What Changes

- **BREAKING** (already shipped in `f1d108f`): the canonical, committed file is `build/repos.example.json` — an example template — not `build/repos.json`. Each install creates its own `build/repos.json` locally.
- **BREAKING** (already shipped in `f1d108f`): per-repo build manifests at `build/<repo-slug>/manifest.json` are local-per-install artifacts, not committed.
- Drop the requirement that the manual CI workflow commits the updated `manifest.json` back to `the-furnace`'s `main` branch on successful workflow-dispatch builds.
- Remove the now-dead "Commit manifest update" step from `.github/workflows/build-devcontainer-images.yml`. The step survived `f1d108f` but is unreachable behavior under the new gitignore (manifests are excluded from `git add`), so the workflow's *intent* still contradicted the new spec until this change.
- The build script, manual workflow, and orchestrator continue to read `build/repos.json` at runtime — the file's role as the runtime source of truth is unchanged; only its lifecycle (local, not committed) changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `devcontainer-image-build`: relax two requirements to match shipped reality — "Tracked repos are listed in build/repos.json" (clarify `repos.json` is local; `repos.example.json` is the committed template) and "Build manifest is the producer/consumer contract surface" (drop the CI commit-back-to-main scenario; manifests are local artifacts).

## Impact

- Mostly retroactive: the file-lifecycle changes shipped in `f1d108f`. The only outstanding code work is removing the dead "Commit manifest update" step in `.github/workflows/build-devcontainer-images.yml`, which `/opsx:verify` surfaced as a coherence issue between the workflow and the new spec.
- Affected files: `openspec/specs/devcontainer-image-build/spec.md` (via delta on archive); `.github/workflows/build-devcontainer-images.yml` (delete the commit step).
- No env var, dependency, or contract-surface changes for downstream consumers (`container-as-worker`, orchestrator) — they still read `build/repos.json` and `build/<slug>/manifest.json` at runtime, just from the local install instead of the committed tree.
