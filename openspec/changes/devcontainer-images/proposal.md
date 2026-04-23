## Why

Concept §3.5: if the target repo already has a `devcontainer.json`, agents must run that exact environment — otherwise a "works for humans, fails in agent container" failure class appears. Pre-warming per-repo images with the repo cloned and dependencies installed keeps cold-start sub-second, which matters when every attempt starts from a clean container.

## What Changes

- Add a `build/` directory with per-repo image build definitions (`build/<repo-slug>/Dockerfile` derived from that repo's `devcontainer.json`).
- Add a build script (`scripts/build-devcontainer-image.ts`) that:
  - Reads the target repo's `devcontainer.json`.
  - Produces a Dockerfile that extends the devcontainer base, clones the repo, and runs the repo's setup commands.
  - Tags and pushes to the configured registry.
- Add a GitHub Actions workflow at `.github/workflows/build-devcontainer-images.yml` that rebuilds images on main commits of tracked repos.
- Add image registry configuration (URL + credentials) via env vars.

## Capabilities

### New Capabilities

- `devcontainer-image-build`: Per-repo image build pipeline derived from each repo's `devcontainer.json`, with pre-cloned source, pre-installed deps, and CI rebuild on main.

### Modified Capabilities

(none)

## Impact

- New files: `build/<repo-slug>/Dockerfile` (one per tracked repo), `scripts/build-devcontainer-image.ts`, `.github/workflows/build-devcontainer-images.yml`.
- New env vars: `DEVCONTAINER_REGISTRY_URL`, `DEVCONTAINER_REGISTRY_TOKEN`.
- Image registry cost and retention policy are out of scope — covered later in `provenance-store` or ops docs.
- MVP targets 1–2 demo repos per concept §4.
