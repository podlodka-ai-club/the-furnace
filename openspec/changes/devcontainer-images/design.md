## Context

Phase 3 of the roadmap is gated on this change: `container-as-worker` boots from a pre-warmed image, and `spec-agent` / `coder-agent` run inside it. The concept's §3.5 commitment ("agents use the exact same spec humans use") and §3.6 commitment ("clean state per attempt") are only honored if the image we ship is a faithful, deterministic snapshot of the target repo's `devcontainer.json` at a specific commit.

The proposal sketches a per-repo image build pipeline, build script, CI workflow, and registry env vars. Earlier review passes flagged devcontainer parity, repo revision pinning, registry contract, runtime digest pinning, prewarming policy honesty, and target-repo trigger semantics; this design addresses those. A subsequent review pass exposed two further gaps that this revision pins down before we write specs:

1. **The push-rebuild trigger can self-trigger via its own manifest commits.** The previous draft included `build/**` in the rebuild path filter *and* committed `build/<slug>/manifest.json` back to `main` after each successful build. That is a feedback loop: a successful build commits a manifest, the manifest path matches the trigger, the workflow fires again, rebuilds (idempotently or not), commits again. The trigger filter must explicitly distinguish *inputs* (cause a rebuild) from *outputs* (must not).
2. **The boundary with `container-as-worker` was overreaching.** A previous draft made this change bake `worker-entry.ts` into every per-repo image and set it as CMD, but `worker-entry.ts` is owned by the later `container-as-worker` change and does not exist yet. This change must stop at producing digest-pinned target-repo environment images plus manifests; `container-as-worker` owns worker launch/wrapping.

This revision tightens Decision 4's path filter and adds Decision 6 to make the producer/consumer boundary explicit without depending on future worker-entry implementation.

## Goals / Non-Goals

**Goals:**
- Build images by invoking the upstream devcontainer machinery against the target repo's own `devcontainer.json`, so the agent's environment is the human's environment by construction (within a stated MVP boundary — see Decisions 1 and 6).
- Make runtime image identity content-addressed (by digest) end-to-end, so workflow attempts cannot observe drift even if a tag is later repointed.
- State the MVP prewarming policy honestly: what is baked into the image, what is not baked, and the trade-offs that follow.
- Define a single, explicit registry contract — naming, tags, digest, auth, discovery — that `container-as-worker` consumes and the build pipeline produces.
- Define an explicit, pull-based trigger model that detects new commits on each tracked target repo's `main` and rebuilds without requiring webhooks or any installation in the target repo, and that does *not* self-trigger via its own outputs.
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
- Installing any workflow or webhook into target repos — the agent system is a passive observer of their `main`.

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
- **Build manifest:** every successful build writes `build/<repo-slug>/manifest.json` containing `{repoSlug, owner, name, ref, commitSha, imageDigest, imageRef, aliasTags: ["sha-${SHA}", "main"], builtAt, devcontainerCliVersion, warmupCommand}`. `imageRef` is the digest reference (the runtime contract); `aliasTags` are documented for human use only. Committed back to main by the CI workflow on rebuild — see Decision 4.
- **Discovery flow:** trigger pipeline (Decision 4) → reads target repo's main HEAD → if changed, builds and updates `build/<repo-slug>/manifest.json` with the new digest. Per-ticket workflow start → reads `manifest.json` for the repo at workflow-start time → freezes `imageRef` (digest reference) into workflow input → `container-as-worker` reads workflow input and pulls `imageRef` exactly as given.

**Rationale:** The contract surface is one file (`manifest.json`) plus two env vars. The producer (build script) writes it; the consumer (`container-as-worker` via workflow input) reads it. Neither side reconstructs the reference from string conventions. Adding the digest as the contract field — not the tag — closes the runtime-identity gap from Decision 2 at the contract level, not just at the pull-time level.

**Alternatives considered:**
- **Manifest carries only the tag, expect consumer to resolve digest at pull:** rejected; pushes resolution responsibility to the worker and reintroduces a TOCTOU window per-pull.
- **Worker constructs reference by string concatenation:** rejected; couples worker to slug and tag rules that should be free to evolve.
- **Query registry for current digest at workflow-start:** rejected; needs registry-list perms, adds a network dependency to cron polling, and the manifest is already authoritative.

### 4) Trigger pipeline: a scheduled poller in the-furnace detects target-repo `main` advances; pipeline-self-changes trigger a full rebuild

**Decision:** Three trigger paths, all running in `.github/workflows/build-devcontainer-images.yml` in the-furnace repo. Target repos are not modified; no webhooks installed.

1. **Scheduled poll (primary trigger for target-repo changes).** A scheduled GitHub Actions workflow (e.g., `cron: */15 * * * *`) iterates every entry in `build/repos.json` and, for each, calls `GET /repos/{owner}/{name}/commits/{ref}` (default `ref: main`) via the GitHub API to read the current main HEAD SHA. If the returned SHA differs from `commitSha` in `build/<repo-slug>/manifest.json`, the workflow runs the build script for that repo. This is the pull model the concept already commits to (§6: "Pull model is simpler — no public endpoint, no webhook secrets"). Latency between a target-repo merge and a rebuild is bounded by the cron interval. The poll reads `TARGET_REPO_GITHUB_TOKEN`, a fine-grained PAT or GitHub App token with read-only access to the tracked repos; the same token is also passed to the build script for the source checkout. The workflow and build script fail before building or pushing if the token is missing or unauthorized, and they never write the token to manifests or logs.

2. **Pipeline self-change (rebuild-all trigger).** `on.push.branches: [main]` with an *inputs-only* `paths` filter that explicitly excludes the workflow's own outputs:

   ```yaml
   paths:
     - scripts/build-devcontainer-image.ts
     - scripts/build/**           # any build-helper TS modules
     - build/repos.json           # the only input file under build/
     - .github/workflows/build-devcontainer-images.yml
     - package.json
     - package-lock.json
   ```

   `build/<slug>/manifest.json` files are *deliberately omitted*. They are produced by this same workflow and committed back to `main` after every successful build (see "After every successful build…" below); including `build/**` would create a self-trigger loop where each manifest commit fires another rebuild. The rule is structural: this trigger names *causes of staleness* (script, deps, config, workflow YAML), never *records of build results*.

   This trigger fires a rebuild of every tracked repo at its current pinned `commitSha`, catching the "build pipeline changed; previously valid images may now be stale relative to the new pipeline" case (e.g., we bumped `@devcontainers/cli` or changed warmup logic).

3. **Manual dispatch (escape hatch).** `on.workflow_dispatch` with optional inputs (`repo`, `commitSha`) for force-rebuilds and bring-up of new repos. The same `scripts/build-devcontainer-image.ts` script is also runnable locally via `npm run build:devcontainer -- --repo <slug> [--sha <sha>]`.

After every successful build, the workflow commits the updated `build/<repo-slug>/manifest.json` back to `main` so the manifest is always coherent with what was pushed to the registry. The commit message records the target repo, slug, commit SHA, and digest for auditability. Because the path filter (above) excludes `build/<slug>/manifest.json`, this commit does not re-trigger the workflow. Defense in depth: the rebuild-all job additionally guards with `if: github.actor != 'github-actions[bot]'` so even an accidental future widening of the path filter cannot reintroduce the loop silently.

**Rationale:** The previous draft said "rebuild on each push to main that touches the target repo," which silently assumed the-furnace and the target repo are the same repo. They aren't. Fixing this requires either (a) installing a workflow/webhook in every target repo (rejected by §6 and by the "don't modify target repos" constraint), or (b) polling target repos from the-furnace. Polling matches the rest of the system (Linear is also polled, per §2). The cron interval is the only operationally tunable knob and is acceptable for MVP given that a 15-minute lag between merge and image rebuild is well below the cycle time of any human review pass that consumes the image.

**Alternatives considered:**
- **`repository_dispatch` from each target repo to the-furnace:** rejected; requires installing a workflow in every target repo and managing a dispatch token there, violating "no modifications to target repos."
- **GitHub webhook receiver in the-furnace:** rejected; needs a public endpoint and webhook secret management per §6.
- **Reuse the existing Linear cron workflow to also poll target repos:** rejected; mixes concerns. Image-rebuild cadence and Linear-polling cadence have different right answers and different failure modes.
- **Per-push watching via a long-running daemon:** rejected; the-furnace has no production deployment yet, and GitHub Actions cron is sufficient.
- **Use `paths-ignore: ["build/*/manifest.json"]` instead of an inputs-only `paths` allowlist:** rejected; allowlists fail safe (a new file under `build/` does not silently start triggering rebuilds) where ignore-lists fail open. The inputs-only allowlist makes the "what causes a rebuild" set explicit and reviewable.
- **Drop the auto-commit and require humans to commit manifest updates:** rejected; manifest is an output, not a curated artifact. Hand-committing creates a window where the registry has a new digest but the manifest still points at the old one — the contract surface goes stale.

### 5) Tracked repos live in `build/repos.json`, not hardcoded in the script

**Decision:** A single `build/repos.json` file lists every tracked repo: `[{slug, owner, name, ref: "main", devcontainerPath?: ".devcontainer/devcontainer.json", workspacePath?: "/workspaces/acme-app", warmupCommand?: "npm ci"}]`. The build script, the scheduled poll workflow, and the pipeline-self-change workflow all read this file. Adding a new repo is a one-line PR.

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

- **[Risk] Cron polling latency means an `agent-ready` ticket that lands right after a target-repo merge runs against the previous image** → Mitigation: bounded by the cron interval (default 15 min). For demo time, the interval can be tightened; for production, GitHub Actions supports down to ~5 min in practice. If a specific demo run needs fresh-merge bytes, `workflow_dispatch` is the manual path. The system is honest about this latency rather than hiding it behind eventual consistency.

- **[Risk] Cron polling rate-limits against GitHub API** → Mitigation: at MVP scale (1–2 repos, every 15 min) this is well under any GitHub limit. Manifest comparison is a single `commits/{ref}` call per tracked repo, not a list.

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
   - Requires `TARGET_REPO_GITHUB_TOKEN` for GitHub API polling and target-repo clone access.
   - Clones target repo at the requested SHA (default: current main HEAD via GitHub API).
   - Invokes `devcontainer build` against the checkout to produce the base.
   - Resolves and records the container workspace path.
   - Builds the warmup phase (clone + opt-in warmup command).
   - Pushes with `--push`, captures the resulting digest.
   - Publishes `:sha-${SHA}` and `:main` alias tags.
   - Writes `build/<repo-slug>/manifest.json` including `imageDigest`.
4. Add `npm run build:devcontainer` script wiring.
5. Add `.github/workflows/build-devcontainer-images.yml` with three triggers from Decision 4 (scheduled poll, push paths, manual dispatch). Includes a step that commits manifest changes back to main on success.
6. Document the registry contract — including the digest-based runtime ref — in `specs/devcontainer-image-build/spec.md` so `container-as-worker` references it as the contract surface.
7. Validate by running the script locally for one demo repo and confirming: (a) the resulting image has the repo cloned at the pinned SHA, (b) `docker pull <imageRef>` resolves via digest from the manifest, (c) the manifest's `imageDigest` matches the registry digest exactly, (d) a simple command can run inside the image to inspect the checked-out repo.

Rollback strategy: this change is additive — no existing module depends on it yet. Removing the build script, workflow, and `build/` directory leaves the rest of the system untouched. Downstream `container-as-worker` is gated on this change being present, so rollback also implies pausing Phase 3.

## Open Questions

- Which registry do we use for MVP — GHCR, an internal registry, or a vendor (ECR/GAR)? Affects auth wiring (OIDC vs. token) but not the contract shape. Defaulting to GHCR with `DEVCONTAINER_REGISTRY_TOKEN = GITHUB_TOKEN` for MVP unless someone speaks up.
- For repos whose `devcontainer.json` references private base images, where do those credentials live? Likely the same registry token, but worth confirming against the demo-repo shortlist.
- What's the right cron interval for the scheduled poll? 15 min is a safe default; demo-day prep may want 5 min. Tunable via the workflow YAML, no code change.
- For a target repo, does the cron poll watch only `main`, or should it follow whatever ref is configured per-repo in `repos.json`? Defaulting to `main` for MVP.
- Should the build script run a smoke test inside the freshly built image (e.g., `docker run` the image and `git rev-parse HEAD` to confirm the pinned source) before publishing? Adds CI minutes but catches "image builds clean but is broken." Lean toward yes; defer the exact gate to tasks.
- Should the workflow always use `GITHUB_TOKEN` for committing manifest updates to the-furnace and reserve `TARGET_REPO_GITHUB_TOKEN` strictly for read-only target-repo polling/cloning?
