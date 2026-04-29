## MODIFIED Requirements

### Requirement: Tracked repos are listed in build/repos.json

The set of tracked target repos SHALL be defined exclusively by entries in a per-install, local `build/repos.json`. The build script, manual workflow, and orchestrator integration SHALL all read this single file at runtime. `build/repos.json` SHALL NOT be committed to the-furnace repository — it is local-per-install state, and `build/*` SHALL be gitignored with the sole exception of the committed template `build/repos.example.json`. New installs SHALL bootstrap their `build/repos.json` by copying `build/repos.example.json`. Adding or removing a tracked repo SHALL NOT require editing the build script or workflow YAML.

#### Scenario: Adding a repo requires only a local config change

- **WHEN** a maintainer adds a new entry `{slug, owner, name}` to their local `build/repos.json`
- **THEN** the build script and manual workflow can build that repo by slug without any build-script code change and without committing the config

#### Scenario: build/repos.json is not committed

- **WHEN** an install creates or modifies `build/repos.json`
- **THEN** the file is ignored by git and does not appear in `git status` or any commit, while `build/repos.example.json` remains the committed template

#### Scenario: New install bootstraps from the example template

- **WHEN** a maintainer sets up a fresh checkout of the-furnace
- **THEN** `build/repos.example.json` is present in the working tree and serves as the documented starting point for creating a local `build/repos.json`

### Requirement: Build manifest is the producer/consumer contract surface

Every successful build SHALL write `build/<repo-slug>/manifest.json` with at minimum the fields `repoSlug`, `commitSha`, `imageDigest`, `imageRef`, `aliasTags`, `builtAt`, `workspacePath`, `devcontainerCliVersion`, and `warmupCommand`. The manifest SHALL be the contract surface read by downstream consumers (`container-as-worker`, orchestrator) for the digest-pinned image reference and workspace path. The manifest SHALL be local-per-install state — `build/<repo-slug>/manifest.json` SHALL NOT be committed to the-furnace repository, and the manual CI workflow SHALL NOT commit manifests back to `main`. The manifest SHALL NOT contain any registry credential or token value.

#### Scenario: Manifest carries the runtime contract fields

- **WHEN** a successful build completes
- **THEN** `build/<repo-slug>/manifest.json` exists locally with `repoSlug`, `commitSha`, `imageDigest`, `imageRef`, `aliasTags`, `builtAt`, `workspacePath`, `devcontainerCliVersion`, and `warmupCommand`, and downstream consumers read those fields to identify and launch the image

#### Scenario: Manifest is not committed

- **WHEN** a build (local or CI) writes or updates `build/<repo-slug>/manifest.json`
- **THEN** the file is ignored by git, no commit is created against `main` for the manifest update, and the registry and local manifest together — not git history — are the source of truth for the most recent build

#### Scenario: Manifest excludes credentials

- **WHEN** any successful build writes a manifest
- **THEN** the file contains no value matching the `DEVCONTAINER_REGISTRY_TOKEN` or any other secret env var
