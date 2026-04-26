## Why

Concept §3.5: if the target repo already has a `devcontainer.json`, agents must run that exact environment — otherwise a "works for humans, fails in agent container" failure class appears. Pre-warming per-repo images with the repo cloned and dependencies installed keeps cold-start sub-second, which matters when every attempt starts from a clean container.

## What Changes

- Add a `build/` directory with tracked-repo configuration (`build/repos.json`) and generated per-repo build manifests (`build/<repo-slug>/manifest.json`).
- Add a build script (`scripts/build-devcontainer-image.ts`) that:
  - Reads the target repo's `devcontainer.json`.
  - Invokes the official devcontainer build path for the repo's image/build/features configuration.
  - Adds the pinned source checkout and any explicit per-repo warmup command.
  - Tags, pushes, and records a digest-pinned runtime image reference in the manifest.
- Add a GitHub Actions workflow at `.github/workflows/build-devcontainer-images.yml` that supports manual rebuilds for a tracked repo/SHA using the same build script.
- Add image registry configuration and read-only target-repo GitHub access via env vars.

## Capabilities

### New Capabilities

- `devcontainer-image-build`: On-demand per-repo image build pipeline derived from each repo's `devcontainer.json`, with pre-cloned source, optional explicit warmup, digest-pinned image manifests, and a manual CI rebuild path.

### Modified Capabilities

(none)

## Impact

- New files: `build/repos.json`, `build/<repo-slug>/manifest.json` (generated per tracked repo), `scripts/build-devcontainer-image.ts`, `.github/workflows/build-devcontainer-images.yml`.
- New env vars: `DEVCONTAINER_REGISTRY_URL`, `DEVCONTAINER_REGISTRY_TOKEN`, and `TARGET_REPO_GITHUB_TOKEN` for resolving refs and cloning tracked target repos.
- Image registry cost and retention policy are out of scope — covered later in `provenance-store` or ops docs.
- MVP targets 1–2 demo repos per concept §4.
