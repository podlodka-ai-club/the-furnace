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

## 8. CI workflow — scheduled poll

- [x] 8.1 Create `.github/workflows/build-devcontainer-images.yml` with a `schedule.cron` trigger defaulting to `*/15 * * * *`
- [x] 8.2 Implement the poll job: iterate `build/repos.json` and fetch each tracked repo's main HEAD via the GitHub API using `TARGET_REPO_GITHUB_TOKEN`
- [x] 8.3 Treat a missing `build/<slug>/manifest.json` as stale and invoke the build script at the returned SHA
- [x] 8.4 For each repo whose returned SHA differs from the manifest's `commitSha`, invoke the build script at the new SHA; leave matching repos untouched
- [x] 8.5 Verify unauthorized or 404 responses for a tracked repo cause a non-zero exit with the slug + owner/name reported, and prevent any image push for that repo

## 9. CI workflow — pipeline self-change rebuild-all

- [x] 9.1 Add a `push.branches: [main]` trigger with an inputs-only `paths` allowlist: `scripts/build-devcontainer-image.ts`, `scripts/build/**`, `build/repos.json`, `.github/workflows/build-devcontainer-images.yml`, `package.json`, `package-lock.json`
- [x] 9.2 Add an inline comment in the workflow YAML stating that `build/<slug>/manifest.json` is intentionally excluded to prevent self-trigger loops
- [x] 9.3 Implement the rebuild-all job: invoke the build script for every entry in `build/repos.json` at its currently pinned `commitSha`
- [x] 9.4 Add `if: github.actor != 'github-actions[bot]'` to the rebuild-all job as defense in depth

## 10. CI workflow — manual dispatch

- [x] 10.1 Add `workflow_dispatch` with optional `repo` and `commitSha` inputs
- [x] 10.2 Implement the dispatch job: invoke the build script with the provided inputs, or rebuild all tracked repos at their current SHAs when `repo` is empty

## 11. CI workflow — manifest commit-back

- [x] 11.1 Add a step that commits the updated `build/<slug>/manifest.json` to `main` on every successful build, authored by `github-actions[bot]`, with a commit message recording slug, target commit SHA, and image digest

## 12. Automated test coverage

- [x] 12.1 Add automated tests for required-env fast failures covering `DEVCONTAINER_REGISTRY_URL`, `DEVCONTAINER_REGISTRY_TOKEN`, and `TARGET_REPO_GITHUB_TOKEN`
- [x] 12.2 Add automated tests for `build/repos.json` validation: requested slug missing, slug mismatch, and normalized-slug collision
- [x] 12.3 Add automated tests for workspace path resolution: explicit `workspacePath`, `devcontainer.json.workspaceFolder`, `/workspaces/<name>` fallback, relative path rejection, and unresolved-variable rejection
- [x] 12.4 Add automated tests for poll/build decision logic: missing manifest builds, matching manifest skips, changed SHA builds, and unauthorized/not-found target repo access fails without publishing
- [x] 12.5 Add automated tests for manifest shape, digest-ref construction, and exclusion of registry/source token values
- [x] 12.6 Run `npm test` from the repo root and keep it passing

## 13. End-to-end validation

- [x] 13.1 Run `npm run build:devcontainer -- --repo <demo-slug>` locally with valid env vars against the initial demo repo
- [x] 13.2 Confirm `docker pull <imageRef>` resolves the image whose digest matches `manifest.json.imageDigest` exactly
- [x] 13.3 Run a one-off `docker run --rm <imageRef>` command (e.g., `ls <workspacePath>`) and confirm the cloned source is present at the recorded workspace path
- [x] 13.4 Inspect the image and confirm no `/opt/furnace/` content exists and the image's `CMD` is the value set by the devcontainer base layer
