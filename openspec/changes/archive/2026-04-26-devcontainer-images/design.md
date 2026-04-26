## Context

Phase 3 of the roadmap is gated on this change: `container-as-worker` boots from a pre-warmed image, and `spec-agent` / `coder-agent` run inside it. The concept's §3.5 commitment ("agents use the exact same spec humans use") and §3.6 commitment ("clean state per attempt") are only honored if the image we ship is a faithful, deterministic snapshot of the target repo's `devcontainer.json` at a specific commit.

The proposal sketches a per-repo image build pipeline, build script, CI workflow, and registry env vars. Earlier review passes flagged devcontainer parity, repo revision pinning, registry contract, runtime digest pinning, prewarming policy honesty, and target-repo trigger semantics; this design addresses those. A subsequent review pass exposed two further gaps that this revision pins down before we write specs:

1. **Background repo polling is not needed for MVP.** The orchestrator starts work from Linear tickets, not from target-repo pushes. Building images just-in-time when a ticket is picked up keeps image production tied to actual agent work and avoids a cron workflow that rebuilds repos with no pending tickets.
2. **The boundary with `container-as-worker` was overreaching.** A previous draft made this change bake `worker-entry.ts` into every per-repo image and set it as CMD, but `worker-entry.ts` is owned by the later `container-as-worker` change and does not exist yet. This change must stop at producing digest-pinned target-repo environment images plus manifests; `container-as-worker` owns worker launch/wrapping.

This revision makes Decision 4 an on-demand trigger model and adds Decision 6 to make the producer/consumer boundary explicit without depending on future worker-entry implementation.

## Goals / Non-Goals

**Goals:**
- Build images by invoking the upstream devcontainer machinery against the target repo's own `devcontainer.json`, so the agent's environment is the human's environment by construction (within a stated MVP boundary — see Decisions 1 and 6).
- Make runtime image identity content-addressed (by digest) end-to-end, so workflow attempts cannot observe drift even if a tag is later repointed.
- State the MVP prewarming policy honestly: what is baked into the image, what is not baked, and the trade-offs that follow.
- Define a single, explicit registry contract — naming, tags, digest, auth, discovery — that `container-as-worker` consumes and the build pipeline produces.
- Define an explicit on-demand trigger model: the Linear-driven orchestrator resolves the target repo/ref to a concrete commit SHA at ticket pickup time, then builds the image for that SHA if it is missing.
- Define an explicit producer contract so `container-as-worker` can consume the image later without this change owning worker launch.
- Support 1–2 demo repos initially, with a build script that scales to additional repos by adding a config entry — not by editing pipeline code.
- Keep the MVP local-buildable and CI-buildable from the same script; no GitHub-Actions-only divergence.

**Non-Goals:**
- Image registry hosting choice, retention policy, GC, or cost accounting (deferred to ops docs / `provenance-store`).
- Multi-architecture images (linux/amd64 only for MVP; arm64 deferred).
- Supporting target repos that lack `devcontainer.json` — explicit failure with actionable error, not a fallback Dockerfile.
- Image signing / SBOM generation (future; tracked in roadmap V1+).
- Mid-attempt image rebuilds or hot-patching; an attempt always uses one frozen image.
- Sub-second cold-start as a hard MVP target (see Decision 1 — explicit downgrade with rationale).
- Baking `devcontainer.json` lifecycle commands (`onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`) into the image. The image's parity claim is bounded to what `devcontainer build` covers (image / build / dockerfile / features) plus an explicit warmup command. Runtime handling of lifecycle commands, if any, belongs to `container-as-worker` or later V1+ work.
- Creating, bundling, mounting, or launching `worker-entry.ts`. That is owned by `container-as-worker`.
- Installing any workflow or webhook into target repos.
- Background polling or scheduled prewarming of target repos for commits with no active agent work.

## Decisions

### 1) Use the official `@devcontainers/cli` to build the base, and define an explicit MVP prewarming policy on top of it

**Decision:** The image build is two layers, with an honest split of responsibility:

- **Base layer:** produced by `devcontainer build` from `@devcontainers/cli` against a fresh checkout of the target repo at the chosen commit. This honors `devcontainer.json`'s `image` / `build` / `dockerfile` / `features` directives. **It does not run lifecycle commands** (`onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`). That is what `devcontainer build` does in the spec; we accept it.
- **Warmup phase:** an additional image-build phase added by the build script. It does exactly two things and no more:
  1. Copy the cloned source tree into the resolved workspace path: `workspacePath` from `build/repos.json`, else `workspaceFolder` from `devcontainer.json`, else `/workspaces/<repo-name>`. The resolved path must be an absolute container path and is recorded in the manifest.
  2. Run an *explicit, opt-in* warmup command from `build/repos.json` (e.g., `npm ci`, `pip install -r requirements.txt`). The warmup command is configured per repo; it defaults to *no warmup* (clone only).

Lifecycle commands from `devcontainer.json` are **not** replayed during this image build. The image's parity claim is therefore explicit and bounded: "what `devcontainer build` covers, plus a clone, plus an opt-in warmup command." Anything else from `devcontainer.json` (lifecycle commands, `runArgs`, `mounts`, `forwardPorts`) is outside this change's producer contract and must be handled, rejected, or documented by downstream `container-as-worker` work.

**Rationale:** The previous draft claimed lifecycle scripts get baked in by `devcontainer build` — they do not, by the spec. Falsely baking them in (e.g., by replaying them as `RUN` steps) introduces a new, subtle drift class: a `postCreateCommand` that depends on the live workspace mount or remote env will behave differently in `RUN` vs. `up`, and we'd be inventing a parallel execution context. The honest, smallest-surface MVP split is: `devcontainer build` does what it does; we add only what we explicitly own (clone + opt-in warmup); downstream runtime behavior remains owned by `container-as-worker`.

This means MVP "exact human environment" is a *bounded* claim, not a *complete* one. For the demo repos we curate, the bound is acceptable; the curation criterion is that the repo's `postCreateCommand` is either covered by an equivalent `warmupCommand` or unnecessary for the agent task.

**Alternatives considered:**
- **Replay `postCreateCommand` as a `RUN` step in the warmup layer (previous draft):** rejected; runs in a non-`up` context (no live mounts, no remote env, possibly different user) and silently diverges from how humans see it run.
- **`devcontainer up` then `docker commit` to capture lifecycle output:** rejected for MVP; reproducibility depends on careful control of mounts, runtime caches, and process state, and the snapshot includes whatever the running container happened to write. Tractable as a V1+ optimization.
- **Skip the warmup layer entirely (clone only):** rejected; an opt-in warmup makes a large practical difference for the demo repos and stays inside what we explicitly own.
- **Hand-authored Dockerfile per repo:** rejected; reintroduces the §3.5 drift the devcontainer-CLI delegation eliminates.

### 2) Runtime image identity is the OCI digest; tags are human-readable aliases

**Decision:** The runtime contract — the reference handed to `container-as-worker` and used to pull at attempt time — is the OCI digest reference: `${REGISTRY}/furnace-${REPO_SLUG}@sha256:${IMAGE_DIGEST}`. Pulling by digest is the only contract surface that survives a malicious or accidental tag repoint.

The build script still publishes tags for human discoverability and tooling convenience:

- `${REGISTRY}/furnace-${REPO_SLUG}:sha-${COMMIT_SHA}` — alias to the digest produced for that commit. Useful for `docker pull` from a developer terminal. **Not** part of the runtime contract.
- `${REGISTRY}/furnace-${REPO_SLUG}:main` — floating alias to the most recent main-branch build. Used by the trigger pipeline (Decision 4) for change detection, never by attempt-time pulls.

The build script captures the digest emitted by the registry on push (e.g., `docker buildx build --push`'s digest output, or a `docker manifest inspect` follow-up) and writes it into the manifest (Decision 3). Workflow inputs carry the **digest**, not the tag. Retries and replays within a workflow always pull `@sha256:${DIGEST}`, so a tag repoint between attempts is structurally invisible to the running system.

**Rationale:** Tag immutability in OCI registries is enforced (or not) only by registry policy. GHCR, ECR, GAR, and Docker Hub all permit overwriting tags by default. A "SHA tag" sounds immutable but isn't; a misconfigured CI step or a malicious actor with push perms can repoint `sha-abc123...` to a different digest, and any consumer pulling by tag silently gets the new bytes. Pulling by digest is the only mechanism that pushes the trust into the registry's content-addressed storage rather than into operational discipline. The §3.6 "clean state per attempt" guarantee survives this.

**Alternatives considered:**
- **Tag-only references with registry-side immutability policy:** rejected; even where supported (e.g., ECR's tag immutability), it is a configuration we'd have to verify on every registry change, and the contract becomes "tag plus assumption" rather than "digest." Compatible as a defense-in-depth layer if the registry supports it.
- **Tag-only with `:sha-${COMMIT}` and a one-time verification at workflow start:** rejected; verifies the digest at start but creates a TOCTOU window between resolve and pull at retry time.
- **Sign images and verify signature:** deferred to V1+; orthogonal to digest-pinning and layered on top.

### 3) Registry contract is the named producer/consumer interface; the manifest carries the digest

**Decision:** A single, explicit registry contract documented in the spec:

- **Runtime image reference template:** `${DEVCONTAINER_REGISTRY_URL}/furnace-${REPO_SLUG}@sha256:${IMAGE_DIGEST}`.
- **Alias tags published alongside (Decision 2):** `:sha-${COMMIT_SHA}` and `:main`. Aliases only — never substituted for the digest at runtime.
- **`REPO_SLUG`:** lowercased `<owner>-<repo>`; non-`[a-z0-9-]` characters replaced with `-`; collisions are explicit build errors (no silent truncation).
- **Auth:** bearer token in `DEVCONTAINER_REGISTRY_TOKEN`; registry host in `DEVCONTAINER_REGISTRY_URL`. Both are required at build time and at pull time. No anonymous pulls in MVP.
- **Build manifest:** every successful build writes `build/<repo-slug>/manifest.json` containing `{repoSlug, owner, name, ref, commitSha, imageDigest, imageRef, aliasTags: ["sha-${SHA}", "main"], builtAt, devcontainerCliVersion, warmupCommand}`. `imageRef` is the digest reference (the runtime contract); `aliasTags` are documented for human use only. Manual CI rebuilds commit the manifest back to main for auditability — see Decision 4.
- **Discovery flow:** Linear poller picks up an agent-ready ticket → orchestrator resolves the target repo/ref (default `main`) to a concrete commit SHA → orchestrator asks the build primitive for an image at that repo/SHA if no suitable manifest/cache entry exists → workflow input freezes `imageRef` (digest reference) → `container-as-worker` reads workflow input and pulls `imageRef` exactly as given.

**Rationale:** The contract surface is one file (`manifest.json`) plus two env vars. The producer (build script) writes it; the consumer (`container-as-worker` via workflow input) reads it. Neither side reconstructs the reference from string conventions. Adding the digest as the contract field — not the tag — closes the runtime-identity gap from Decision 2 at the contract level, not just at the pull-time level.

**Alternatives considered:**
- **Manifest carries only the tag, expect consumer to resolve digest at pull:** rejected; pushes resolution responsibility to the worker and reintroduces a TOCTOU window per-pull.
- **Worker constructs reference by string concatenation:** rejected; couples worker to slug and tag rules that should be free to evolve.
- **Query registry for current digest at workflow-start:** rejected; needs registry-list perms and makes the orchestrator reconstruct image identity instead of consuming the manifest contract.

### 4) Trigger model: build on demand from Linear ticket processing; keep manual workflow dispatch for debugging

**Decision:** This change exposes a single build primitive: `npm run build:devcontainer -- --repo <slug> [--sha <commitSha>]`. If `--sha` is omitted, the script resolves the repo's configured `ref` (default `main`) to the current commit SHA via the GitHub API before building.

The MVP orchestrator model is just-in-time:

1. Linear poller finds an `agent-ready` ticket.
2. The orchestrator identifies the target repo and base ref for that ticket; for MVP, the ref defaults to the repo's configured `ref` in `build/repos.json`.
3. The orchestrator resolves that ref to an exact commit SHA and checks whether an image/manifest for that repo/SHA already exists.
4. If missing, the orchestrator runs the build primitive for that repo/SHA, records the digest-pinned `imageRef`, and starts the agent from that digest.

The GitHub Actions workflow is only a manual `workflow_dispatch` escape hatch for rebuilds, debugging, and demo setup. It requires `repo` and accepts optional `commitSha`; it invokes the same build script and commits the updated `build/<repo-slug>/manifest.json` back to `main` for auditability. There is no scheduled poller and no push-triggered rebuild-all in MVP.

**Rationale:** The system's real work starts from Linear tickets. Rebuilding images on a cron when target repos move forward creates background operational noise, registry churn, and branch-protection questions for repos with no pending agent work. Building just-in-time ties the image to the exact ticket/run that needs it. The trade-off is first-ticket latency after a repo changes; acceptable for MVP and much easier to reason about.

**Alternatives considered:**
- **Scheduled target-repo polling:** rejected for MVP; it prebuilds images independent of actual Linear work and adds cron/API/commit-back complexity.
- **`repository_dispatch` from each target repo to the-furnace:** rejected; requires installing a workflow in every target repo and managing a dispatch token there.
- **GitHub webhook receiver in the-furnace:** rejected; needs a public endpoint and webhook secret management.
- **Pipeline self-change rebuild-all:** rejected for MVP; if the build pipeline changes, a maintainer can manually dispatch a rebuild, and later orchestration can invalidate cache keys using builder-version metadata.
- **Drop the manual workflow and use local builds only:** rejected; a CI path is useful for demo setup and registry-backed rebuilds without requiring a developer machine.

### 5) Tracked repos live in `build/repos.json`, not hardcoded in the script

**Decision:** A single `build/repos.json` file lists every tracked repo: `[{slug, owner, name, ref: "main", devcontainerPath?: ".devcontainer/devcontainer.json", workspacePath?: "/workspaces/acme-app", warmupCommand?: "npm ci"}]`. The build script, the manual workflow, and later orchestrator integration all read this file. Adding a new repo is a one-line PR.

**Rationale:** Concept §4 calls for 1–2 demo repos for MVP, growing afterward. Embedding the list in the script means every new repo is a code change with review surface; embedding it in CI YAML duplicates state. A small JSON registry is the lowest-friction extension point and cleanly separates "what we track" from "how we build." `warmupCommand` is per-repo so each tracked repo opts in to its own warmup, consistent with Decision 1. `workspacePath?` exists because `devcontainer.json.workspaceFolder` is itself optional in the upstream spec — without an override and a deterministic fallback chain (`repos.json[].workspacePath` → `devcontainer.json.workspaceFolder` → `/workspaces/<name>`), repos that omit `workspaceFolder` would have undefined warmup-target behavior. The resolved absolute path is recorded in `manifest.json` so consumers don't re-derive it.

### 6) Producer contract stops at environment image plus manifest; worker launch belongs to `container-as-worker`

**Decision:** The boundary between this change and `container-as-worker` is a single, explicit producer contract:

- **What `devcontainer-images` produces:** an OCI environment image at `${REGISTRY}/furnace-${SLUG}@sha256:${DIGEST}` whose build inputs are: (a) `devcontainer build` output, (b) target repo cloned into the resolved workspace path at the pinned commit, (c) opt-in warmup command output. The image does not contain the-furnace worker bootstrap and does not set a furnace-specific CMD.
- **What the manifest promises:** `manifest.json` gives downstream code the digest-pinned `imageRef`, target repo identity, target commit SHA, resolved workspace path, devcontainer CLI version, and warmup command that produced the image. It is a lookup contract, not a launch contract.
- **What `container-as-worker` owns later:** deciding whether to consume `imageRef` via `docker run` with a command override, a wrapper image, `devcontainer up`, a bind-mounted worker entrypoint, or another launch strategy. That change also owns the mount/env/CMD contract for `~/.claude`, Temporal task queues, and worker lifecycle.
- **What is *not* handled by this change:** `devcontainer.json` lifecycle commands (`onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`), `runArgs`, `mounts`, `forwardPorts`, `remoteUser` beyond what `devcontainer build` embeds. If a tracked repo depends on any of these for agent execution, either `warmupCommand` must cover the needed setup or `container-as-worker` must explicitly account for it.

This keeps the roadmap ordering intact: `devcontainer-images` creates reusable, digest-pinned environment images; `container-as-worker` later turns those images into single-task Temporal workers.

**Rationale:** Baking `worker-entry.ts` into these images would make this change depend on code owned by the next change and would expand scope from "pre-warmed target-repo images" to "agent worker runtime." It would also force image rebuilds on worker-entry changes, Temporal activity wiring changes, or worker runtime dependency changes — concerns that belong to `container-as-worker`. Keeping images environment-only avoids a target-repo × the-furnace-worker image matrix until the runtime shape is actually designed.

The price is that this design no longer decides exactly how attempts are launched. That is intentional: the next change can choose the launch strategy with the actual `worker-entry.ts` shape in hand, while still relying on the digest-pinned imageRef contract from this change.

**Alternatives considered:**
- **Bake `worker-entry.ts` into each image in this change.** Rejected; `worker-entry.ts` is owned by `container-as-worker`, does not exist yet, and would make this change depend on future implementation.
- **Define `docker run imageRef` plus command override here.** Rejected; it would still define the launch contract before the worker entrypoint exists.
- **Define `devcontainer up` runtime here.** Rejected for this change; it is a plausible `container-as-worker` option, but deciding it here would mix image production with worker orchestration.
- **Create wrapper images here.** Rejected; wrapper shape depends on worker runtime details and should be owned by `container-as-worker` if needed.

## Risks / Trade-offs

- **[Risk] `@devcontainers/cli` itself drifts or has bugs we hit before upstream fixes them** → Mitigation: pin the CLI version in `package.json` and record it in `manifest.json` so we know what built each image. Upgrade is a deliberate change, not a moving target.

- **[Risk] A tracked repo's `devcontainer.json` lifecycle commands (e.g., `postCreateCommand`) are not baked into the image — agent runs against an incomplete environment if downstream runtime does not compensate** → Mitigation: this is the explicit Decisions 1 + 6 gap. The repo's `warmupCommand` in `repos.json` is the opt-in lever to replicate dependency setup that can safely run at build time. Curation criterion for the tracked-repo list: every tracked repo's lifecycle commands are either replicated by `warmupCommand`, confirmed unnecessary for the agent task, or explicitly left for `container-as-worker` runtime handling.

- **[Risk] First ticket after a target-repo change waits for an image build** → Mitigation: accepted for MVP. The orchestrator can surface "building environment image" as run state, and `workflow_dispatch` remains available for demo prep.

- **[Risk] Manifest.json drift between branches** → Mitigation: the workflow commits manifest updates only to `main`; non-main branches do not consume the manifest at runtime. If a developer hand-edits manifest.json on a feature branch, it has no runtime effect until merged.

- **[Risk] Tag repoint by an attacker with registry push perms** → Mitigation: digest-pinned runtime contract (Decision 2) makes tag-repoints invisible to running workflows. The registry's tag-immutability flag, where supported, is recommended as defense-in-depth but not relied on.

- **[Risk] Image size grows large because deps are baked in via warmup** → Mitigation: layer caching keeps incremental rebuilds cheap. If a single repo's image exceeds a soft threshold (e.g., 5 GB), revisit then; do not preemptively optimize.

- **[Risk] Registry credentials leak via `manifest.json` or build logs** → Mitigation: `manifest.json` only contains image references and digests, never credentials. Build script is forbidden from echoing `DEVCONTAINER_REGISTRY_TOKEN`; CI workflow uses GitHub-secret masking.

- **[Trade-off] Hard requirement on `devcontainer.json` excludes repos that don't have one** → Acceptable per §3.5.

- **[Trade-off] Digest-pinning means a workflow can never opportunistically pick up a fix shipped after it started** → Acceptable per §3.6. A workflow that needs the new image is a *new* workflow, started from a new ticket or retry that re-resolves through the manifest.

- **[Trade-off] MVP "exact human environment" parity is bounded, not complete** → Acceptable. Decisions 1 + 6 commit to a bounded parity claim (`devcontainer build` output + clone + opt-in warmup), with lifecycle commands not baked by this change. The parity gap means tracked repos must satisfy the curation criterion above. V1+ work or `container-as-worker` can close the runtime gap.

- **[Trade-off] This change does not prove a full Temporal worker can start from the image** → Acceptable. The image is a prerequisite artifact. `container-as-worker` owns the launch path and integration tests that prove worker lifecycle.

## Migration Plan

1. Add `@devcontainers/cli` to `package.json` (devDependency), pinned.
2. Add `build/repos.json` with the initial 1–2 demo repos and `build/<slug>/` placeholder directories.
3. Add `scripts/build-devcontainer-image.ts`:
   - Requires `TARGET_REPO_GITHUB_TOKEN` for GitHub API ref resolution and target-repo clone access.
   - Clones target repo at the requested SHA (default: current main HEAD via GitHub API).
   - Invokes `devcontainer build` against the checkout to produce the base.
   - Resolves and records the container workspace path.
   - Builds the warmup phase (clone + opt-in warmup command).
   - Pushes with `--push`, captures the resulting digest.
   - Publishes `:sha-${SHA}` and `:main` alias tags.
   - Writes `build/<repo-slug>/manifest.json` including `imageDigest`.
4. Add `npm run build:devcontainer` script wiring.
5. Add `.github/workflows/build-devcontainer-images.yml` with the manual dispatch trigger from Decision 4. Includes a step that commits manifest changes back to main on success.
6. Document the registry contract — including the digest-based runtime ref — in `specs/devcontainer-image-build/spec.md` so `container-as-worker` references it as the contract surface.
7. Validate by running the script locally for one demo repo and confirming: (a) the resulting image has the repo cloned at the pinned SHA, (b) `docker pull <imageRef>` resolves via digest from the manifest, (c) the manifest's `imageDigest` matches the registry digest exactly, (d) a simple command can run inside the image to inspect the checked-out repo.

Rollback strategy: this change is additive — no existing module depends on it yet. Removing the build script, workflow, and `build/` directory leaves the rest of the system untouched. Downstream `container-as-worker` is gated on this change being present, so rollback also implies pausing Phase 3.

## Open Questions

- Which registry do we use for MVP — GHCR, an internal registry, or a vendor (ECR/GAR)? Affects auth wiring (OIDC vs. token) but not the contract shape. Defaulting to GHCR with `DEVCONTAINER_REGISTRY_TOKEN = GITHUB_TOKEN` for MVP unless someone speaks up.
- For repos whose `devcontainer.json` references private base images, where do those credentials live? Likely the same registry token, but worth confirming against the demo-repo shortlist.
- Should the build script run a smoke test inside the freshly built image (e.g., `docker run` the image and `git rev-parse HEAD` to confirm the pinned source) before publishing? Adds CI minutes but catches "image builds clean but is broken." Lean toward yes; defer the exact gate to tasks.
- Should the workflow always use `GITHUB_TOKEN` for committing manifest updates to the-furnace and reserve `TARGET_REPO_GITHUB_TOKEN` strictly for read-only target-repo ref resolution/cloning?
