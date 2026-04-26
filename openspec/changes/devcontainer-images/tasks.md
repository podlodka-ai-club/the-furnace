## 1. Setup

- [x] 1.1 Add `@devcontainers/cli` to root `package.json` as a pinned devDependency
- [x] 1.2 Create `build/repos.json` with the schema `[{slug, owner, name, ref, devcontainerPath?, workspacePath?, warmupCommand?}]` and one initial demo-repo entry; `slug` is a checked identity and must equal normalized `<owner>-<name>`, not an override
- [x] 1.3 Document required env vars (`DEVCONTAINER_REGISTRY_URL`, `DEVCONTAINER_REGISTRY_TOKEN`, `TARGET_REPO_GITHUB_TOKEN`) in `.env.example` or README

## 2. Build script — entrypoint and validation

- [x] 2.1 Create `scripts/build-devcontainer-image.ts` with CLI args `--repo <slug>` and optional `--sha <commitSha>`
- [x] 2.2 Fail fast with a named-variable error before any clone or build work if any of `DEVCONTAINER_REGISTRY_URL`, `DEVCONTAINER_REGISTRY_TOKEN`, `TARGET_REPO_GITHUB_TOKEN` is unset
- [x] 2.3 Load and validate `build/repos.json`; reject if the requested slug is missing
- [x] 2.4 Implement deterministic slug normalization (`<owner>-<name>` lowercased, non-`[a-z0-9-]` replaced with `-`); fail with an explicit collision error if two entries normalize to the same slug
- [x] 2.5 Reject any `build/repos.json` entry whose configured `slug` does not equal the normalized `<owner>-<name>` value before any clone or build work runs

## 3. Build script — target repo acquisition

- [x] 3.1 Resolve target commit SHA: use `--sha` if provided, else fetch current main HEAD via the GitHub API using `TARGET_REPO_GITHUB_TOKEN`
- [x] 3.2 Clone the target repo at the resolved SHA into a temp directory using the same token
- [x] 3.3 Verify `devcontainer.json` exists at the configured `devcontainerPath` (default `.devcontainer/devcontainer.json`); fail with an actionable error naming the slug and expected path on miss
- [x] 3.4 Resolve the workspace path via the chain `repos.json[].workspacePath` → `devcontainer.json.workspaceFolder` → `/workspaces/<name>`; fail before any image work if the resolved path is relative or contains unresolved `${...}` variables

## 4. Build script — image build

- [x] 4.1 Invoke `devcontainer build` from `@devcontainers/cli` against the cloned checkout to produce the base image
- [x] 4.2 Add the warmup phase: copy the cloned source tree into the resolved workspace path inside the image
- [x] 4.3 Run `warmupCommand` from `repos.json` in the warmup phase when configured; do nothing extra when omitted
- [x] 4.4 Verify the warmup phase does not replay any `devcontainer.json` lifecycle command (`onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`)

## 5. Build script — registry push and digest capture

- [x] 5.1 Authenticate to the registry using `DEVCONTAINER_REGISTRY_URL` and `DEVCONTAINER_REGISTRY_TOKEN`
- [x] 5.2 Push the image and capture the registry-emitted `sha256:<digest>`; fail the build if the digest is missing or not a 64-char hex string
- [x] 5.3 Publish alias tags `:sha-${COMMIT_SHA}` and `:main` pointing at the same digest

## 6. Build script — manifest

- [x] 6.1 Write `build/<slug>/manifest.json` containing `repoSlug`, `commitSha`, `imageDigest`, `imageRef` (digest reference), `aliasTags`, `builtAt`, `workspacePath`, `devcontainerCliVersion`, and `warmupCommand`
- [x] 6.2 Confirm the manifest contains no value matching `DEVCONTAINER_REGISTRY_TOKEN` or `TARGET_REPO_GITHUB_TOKEN`
- [x] 6.3 Confirm the produced image carries no `/opt/furnace/` content and no furnace-specific `CMD` override

## 7. Local entry point

- [x] 7.1 Add `npm run build:devcontainer` in root `package.json` invoking `scripts/build-devcontainer-image.ts`
- [x] 7.2 Confirm a local invocation for a known repo+SHA produces a manifest of the same shape and field set as a CI invocation for the same inputs

## 8. CI workflow — manual dispatch only

- [x] 8.1 Create `.github/workflows/build-devcontainer-images.yml` with `workflow_dispatch` and required `repo` plus optional `commitSha` inputs
- [x] 8.2 Implement the dispatch job: invoke the build script for the provided repo and optional SHA
- [x] 8.3 Keep the workflow free of `schedule` and `push` triggers for MVP so images are not rebuilt in the background
- [x] 8.4 Add a step that commits the updated `build/<slug>/manifest.json` to `main` on every successful manual build, authored by `github-actions[bot]`, with a commit message recording slug, target commit SHA, and image digest

## 9. Automated test coverage

- [x] 9.1 Add automated tests for required-env fast failures covering `DEVCONTAINER_REGISTRY_URL`, `DEVCONTAINER_REGISTRY_TOKEN`, and `TARGET_REPO_GITHUB_TOKEN`
- [x] 9.2 Add automated tests for `build/repos.json` validation: requested slug missing, slug mismatch, and normalized-slug collision
- [x] 9.3 Add automated tests for workspace path resolution: explicit `workspacePath`, `devcontainer.json.workspaceFolder`, `/workspaces/<name>` fallback, relative path rejection, and unresolved-variable rejection
- [x] 9.4 Add automated tests for CLI mode validation: `--repo`, optional `--sha`, and rejection of background rebuild modes
- [x] 9.5 Add automated tests for unauthorized/not-found target repo access failing without publishing
- [x] 9.6 Add automated tests for manifest shape, digest-ref construction, and exclusion of registry/source token values
- [x] 9.7 Run `npm test` from the repo root and keep it passing

## 10. End-to-end validation

- [x] 10.1 Run `npm run build:devcontainer -- --repo <demo-slug> --sha <commitSha>` locally with valid env vars against the initial demo repo
- [x] 10.2 Confirm `docker pull <imageRef>` resolves the image whose digest matches `manifest.json.imageDigest` exactly
- [x] 10.3 Run a one-off `docker run --rm <imageRef>` command (e.g., `ls <workspacePath>`) and confirm the cloned source is present at the recorded workspace path
- [x] 10.4 Inspect the image and confirm no `/opt/furnace/` content exists and the image's `CMD` is the value set by the devcontainer base layer
- [x] 10.5 Add `npm run test:devcontainer:e2e` to automate the local registry, demo SHA resolution, build, digest pull, and workspace smoke check
