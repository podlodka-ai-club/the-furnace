## ADDED Requirements

### Requirement: Image base built via official devcontainer CLI

The build pipeline SHALL produce the base image layer by invoking `devcontainer build` from the upstream `@devcontainers/cli` package against a fresh checkout of the target repo at the pinned commit. The build pipeline SHALL NOT author or maintain a parallel per-repo Dockerfile that approximates `devcontainer.json`.

#### Scenario: Build delegates to devcontainer CLI

- **WHEN** the build script runs against a tracked repo with a valid `devcontainer.json`
- **THEN** the resulting base image is produced by `devcontainer build`, honoring the repo's `image` / `build` / `dockerfile` / `features` directives, and no hand-authored Dockerfile is checked into `build/<repo-slug>/`

#### Scenario: Devcontainer CLI version is recorded

- **WHEN** the build script completes a successful build
- **THEN** `manifest.json` contains a `devcontainerCliVersion` field equal to the pinned CLI version used during the build

### Requirement: Warmup phase pre-bakes only the source clone and an opt-in command

On top of the devcontainer-built base, the build pipeline SHALL add a warmup phase whose only effects are copying the cloned source into the resolved workspace path and optionally running the per-repo `warmupCommand` from `build/repos.json`. The implementation MAY produce multiple OCI layers for that phase, but it SHALL NOT add any other setup behavior. The build pipeline SHALL NOT replay any `devcontainer.json` lifecycle command (`onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`) or honor `runArgs` / `mounts` / `forwardPorts` directives in this phase.

The workspace path SHALL resolve in this order: `workspacePath` from `build/repos.json`, then `workspaceFolder` from `devcontainer.json`, then `/workspaces/<repo-name>`. The resolved workspace path SHALL be an absolute container path and SHALL be recorded as `workspacePath` in `manifest.json`; unresolved variables or relative paths SHALL fail before image build or push.

#### Scenario: Repo with no warmupCommand produces clone-only warmup

- **WHEN** a tracked repo's entry in `build/repos.json` omits `warmupCommand`
- **THEN** the warmup phase copies the cloned source into the resolved workspace path and adds nothing else

#### Scenario: Repo with warmupCommand runs only that command

- **WHEN** a tracked repo's entry in `build/repos.json` sets `warmupCommand: "npm ci"`
- **THEN** the warmup phase runs exactly `npm ci` after the source copy and runs no `devcontainer.json` lifecycle commands

#### Scenario: Workspace path falls back deterministically

- **WHEN** a tracked repo entry omits `workspacePath` and its `devcontainer.json` omits `workspaceFolder`
- **THEN** the build pipeline copies the cloned source to `/workspaces/<repo-name>` and records that absolute path in `manifest.json`

#### Scenario: Invalid workspace path fails before push

- **WHEN** the resolved workspace path is relative or contains unresolved variables
- **THEN** the build exits with a non-zero status naming the repo slug and invalid workspace path, and no image is pushed

### Requirement: Target repos without devcontainer.json are rejected

The build pipeline SHALL fail with an actionable error when the target repo at the pinned commit does not contain a `devcontainer.json` at the configured `devcontainerPath` (or `.devcontainer/devcontainer.json` by default). The build pipeline SHALL NOT fall back to a generic Dockerfile or skip the repo silently.

#### Scenario: Missing devcontainer.json fails the build

- **WHEN** the build script runs against a repo that has no `devcontainer.json`
- **THEN** the build exits with a non-zero status and an error message naming the expected path and the configured repo slug, and no image is pushed

### Requirement: Runtime image identity is the OCI digest

Every successful build SHALL push an image whose runtime reference is `${DEVCONTAINER_REGISTRY_URL}/furnace-${REPO_SLUG}@sha256:${IMAGE_DIGEST}`. Downstream consumers SHALL identify and pull images by this digest reference, never by tag. The build script SHALL capture the image digest emitted by the registry on push and SHALL fail the build if the digest cannot be captured.

#### Scenario: Digest captured on push

- **WHEN** the build script pushes an image to the registry
- **THEN** the script reads back the registry-emitted `sha256:` digest and proceeds only if a 64-char hex digest was returned

#### Scenario: Manifest carries the digest reference

- **WHEN** a successful build completes
- **THEN** `manifest.json` contains `imageDigest` (the `sha256:` value) and `imageRef` formed as `${DEVCONTAINER_REGISTRY_URL}/furnace-${REPO_SLUG}@sha256:${IMAGE_DIGEST}`

### Requirement: SHA and main alias tags are published alongside the digest

Every successful build SHALL also publish two human-readable alias tags pointing at the same digest: `${REGISTRY}/furnace-${REPO_SLUG}:sha-${COMMIT_SHA}` and `${REGISTRY}/furnace-${REPO_SLUG}:main`. These tags SHALL be documented as discovery aliases only and SHALL NOT appear in any runtime contract surface read by `container-as-worker`.

#### Scenario: Both alias tags are pushed

- **WHEN** a build for `acme-app` at commit `abc123…` succeeds
- **THEN** the registry exposes `furnace-acme-app:sha-abc123…` and `furnace-acme-app:main` both pointing at the same digest as the runtime `imageRef`

#### Scenario: Manifest distinguishes runtime ref from alias tags

- **WHEN** `manifest.json` is read
- **THEN** `imageRef` is the digest reference and `aliasTags` lists the tag aliases separately, with no field that conflates the two

### Requirement: Build manifest is the producer/consumer contract surface

Every successful build SHALL write `build/<repo-slug>/manifest.json` with at minimum the fields `repoSlug`, `commitSha`, `imageDigest`, `imageRef`, `aliasTags`, `builtAt`, `workspacePath`, `devcontainerCliVersion`, and `warmupCommand`. The CI workflow SHALL commit the updated manifest back to the-furnace's `main` branch on every successful build so the manifest is always coherent with the registry state. The manifest SHALL NOT contain any registry credential or token value.

#### Scenario: Manifest is committed back to main on success

- **WHEN** a CI build completes successfully and pushes the image
- **THEN** the workflow commits the updated `build/<repo-slug>/manifest.json` to the-furnace's `main` branch in a commit authored by `github-actions[bot]` whose message references the slug, target commit SHA, and digest

#### Scenario: Manifest excludes credentials

- **WHEN** any successful build writes a manifest
- **THEN** the file contains no value matching the `DEVCONTAINER_REGISTRY_TOKEN` or any other secret env var

### Requirement: Registry auth is supplied via fixed env vars at both build and pull

The build pipeline and any downstream consumer SHALL read the registry host from `DEVCONTAINER_REGISTRY_URL` and the bearer credential from `DEVCONTAINER_REGISTRY_TOKEN`. The build pipeline SHALL fail if either variable is unset at build time. Anonymous registry access SHALL NOT be used in MVP.

#### Scenario: Missing registry env vars fail fast

- **WHEN** the build script is invoked without `DEVCONTAINER_REGISTRY_URL` or `DEVCONTAINER_REGISTRY_TOKEN`
- **THEN** the script exits with a non-zero status and an error naming the missing variable, before any clone or image build work runs

### Requirement: Target repo GitHub access is supplied via a fixed read token

The scheduled poll workflow and build script SHALL read target-repo GitHub API and clone credentials from `TARGET_REPO_GITHUB_TOKEN`. The token SHALL have read-only access to every tracked target repo in `build/repos.json`. The workflow and build script SHALL fail before image build or push if the token is missing, cannot read a tracked repo's configured ref, or cannot clone the target source at the selected commit. The token SHALL NOT be written to `manifest.json` or logged.

#### Scenario: Missing target repo token fails fast

- **WHEN** the scheduled poll workflow or build script needs to poll or clone a tracked target repo and `TARGET_REPO_GITHUB_TOKEN` is unset
- **THEN** it exits with a non-zero status and an error naming `TARGET_REPO_GITHUB_TOKEN`, before any image build or push work runs

#### Scenario: Unauthorized target repo access fails without publishing

- **WHEN** GitHub API polling or source clone returns unauthorized or not-found for a tracked repo
- **THEN** the workflow reports the configured repo slug and owner/name, exits with a non-zero status, and does not build or push an image for that repo

### Requirement: Repository slug normalization is deterministic and collision-safe

The build pipeline SHALL derive `REPO_SLUG` from a target repo's `<owner>/<name>` by lowercasing and replacing every character outside `[a-z0-9-]` with `-`. If two distinct repos in `build/repos.json` would normalize to the same slug, the build pipeline SHALL fail with an explicit collision error rather than silently overwrite either image.

#### Scenario: Slug normalization rejects collisions

- **WHEN** `build/repos.json` contains entries that normalize to the same slug
- **THEN** the build script exits with a non-zero status, reports both colliding repos, and does not push any image

### Requirement: Tracked repos are listed in build/repos.json

The set of tracked target repos SHALL be defined exclusively by entries in `build/repos.json`. The build script, scheduled poll workflow, and pipeline-self-change workflow SHALL all read this single file. Adding or removing a tracked repo SHALL NOT require editing the build script or workflow YAML.

#### Scenario: Adding a repo requires only a config change

- **WHEN** a maintainer adds a new entry `{slug, owner, name}` to `build/repos.json` and merges it
- **THEN** the next scheduled poll detects the new repo and the build pipeline produces an image and manifest for it without any code or workflow YAML changes

### Requirement: Scheduled poll detects target-repo main advances

A scheduled GitHub Actions workflow SHALL run on a fixed cron, iterate every entry in `build/repos.json`, and read the current main HEAD SHA of each tracked repo via the GitHub API. For any repo whose returned SHA differs from `commitSha` in `build/<repo-slug>/manifest.json`, the workflow SHALL invoke the build script for that repo at the new SHA. Target repos SHALL NOT be required to install any workflow, webhook, or other modification.

#### Scenario: New target-repo main commit triggers rebuild

- **WHEN** a tracked target repo's main HEAD has advanced past the SHA recorded in its manifest at the time the cron fires
- **THEN** the workflow runs the build script for that repo at the new SHA and publishes a new digest, leaving other tracked repos untouched

#### Scenario: No target-repo change triggers no build

- **WHEN** all tracked repos' current main HEADs match their manifests at the time the cron fires
- **THEN** the workflow exits without invoking the build script and without pushing any image

### Requirement: Pipeline self-change triggers a rebuild-all using an inputs-only path filter

The build workflow SHALL also trigger on push to the-furnace's `main` for an explicit allowlist of pipeline input paths only — the build script and any helper modules under `scripts/`, `build/repos.json`, the workflow YAML itself, and root dependency lockfiles. The path filter SHALL NOT include `build/<slug>/manifest.json` or any other generated output. When this trigger fires, the workflow SHALL rebuild every tracked repo at its currently pinned `commitSha`.

#### Scenario: Pipeline-source change rebuilds all tracked repos

- **WHEN** a commit on the-furnace's main modifies `scripts/build-devcontainer-image.ts`
- **THEN** the workflow rebuilds an image for every entry in `build/repos.json` at its current pinned commit SHA

#### Scenario: Manifest commits do not re-trigger the workflow

- **WHEN** the workflow commits an updated `build/<repo-slug>/manifest.json` back to main as part of a successful build
- **THEN** that commit does not match the rebuild-all path filter and does not trigger another workflow run

### Requirement: Bot-authored commits are guarded against re-triggering rebuild-all

As a defense-in-depth measure complementing the path filter, the rebuild-all job SHALL skip when the triggering push was authored by `github-actions[bot]`. This guard SHALL be in addition to, not in place of, the inputs-only path filter.

#### Scenario: Bot manifest commit is skipped by the rebuild-all job

- **WHEN** a push event reaches the workflow and the actor is `github-actions[bot]`
- **THEN** the rebuild-all job evaluates its `if` guard to false and runs no build steps

### Requirement: Manual dispatch trigger and local script share one entry point

The build workflow SHALL expose a `workflow_dispatch` trigger that accepts optional `repo` and `commitSha` inputs and invokes the same build script used by the other triggers. The build script SHALL also be runnable locally via `npm run build:devcontainer` with equivalent arguments, producing equivalent output, so that local and CI builds do not diverge.

#### Scenario: Manual dispatch builds a single repo at a chosen SHA

- **WHEN** a maintainer triggers `workflow_dispatch` with `repo=acme-app` and `commitSha=abc123…`
- **THEN** the workflow runs the build script for `acme-app` at `abc123…` and updates only that repo's manifest

#### Scenario: Local invocation produces an equivalent manifest

- **WHEN** a maintainer runs `npm run build:devcontainer -- --repo acme-app --sha abc123…` locally with valid registry env vars
- **THEN** the resulting `manifest.json` has the same shape and field set as the CI-produced manifest for the same inputs

### Requirement: Producer contract is image plus manifest; worker launch is out of scope

This change SHALL produce only the digest-pinned environment image and its manifest. This change SHALL NOT bake any the-furnace runtime code (including but not limited to `worker-entry.ts`), set a furnace-specific image `CMD`, define mount contracts beyond what `devcontainer build` embeds, or prescribe how the image is launched at attempt time. Worker launch, mounts, environment, and lifecycle handling at runtime are owned by `container-as-worker`.

#### Scenario: Produced image carries no the-furnace runtime code

- **WHEN** a built image is inspected
- **THEN** it contains no files under `/opt/furnace/` and no the-furnace bundle is present at any path

#### Scenario: Image CMD is unchanged from devcontainer base

- **WHEN** a built image's metadata is inspected
- **THEN** its `CMD` is exactly the value set by the devcontainer-built base layer (no override applied by the warmup layer)
