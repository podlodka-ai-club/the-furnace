## 1. Verify shipped reality matches the delta

- [x] 1.1 Confirm `.gitignore` excludes `build/*` except `build/repos.example.json` (verified — `.gitignore:3-4`)
- [x] 1.2 Confirm `build/repos.example.json` exists in the committed tree and `build/repos.json` is absent from git history past `f1d108f` (verified — `git ls-files build/` → only `repos.example.json`; `repos.json` last seen at `c98f2a0`, removed at `f1d108f`)
- [x] 1.3 Audit `.github/workflows/*.yml` for any step that commits `build/<slug>/manifest.json` back to `main` (verified — surfaced one stale step in `build-devcontainer-images.yml`; addressed in §2)
- [x] 1.4 Confirm the build script and orchestrator still read `build/repos.json` and `build/<slug>/manifest.json` from the local working tree at runtime (verified — `scripts/build/devcontainer-image.ts:103`, `server/src/temporal/repo-registry.ts:29`)

## 2. Workflow cleanup

- [x] 2.1 Remove the "Commit manifest update" step from `.github/workflows/build-devcontainer-images.yml` so the workflow no longer encodes the old "commit manifests back to main" intent
- [ ] 2.2 Decide whether to also drop the `contents: write` permission on the workflow, which was added solely for the deleted commit step. Default: leave it for now and revisit if a workflow audit later flags unused permissions, since dropping it is a separate scope decision and not required for spec coherence

## 3. Validate the change

- [x] 3.1 Run `openspec validate local-build-config` to confirm the delta parses and references existing requirement names (verified — "Change is valid")
- [ ] 3.2 Re-run `/opsx:verify` after the workflow edit to confirm no remaining drift between spec and code

## 4. Archive

- [ ] 4.1 Run `/opsx:archive` to fold the MODIFIED requirements into `openspec/specs/devcontainer-image-build/spec.md`
- [ ] 4.2 Confirm the archived spec no longer mentions committing `repos.json` or `manifest.json` to git, and references `build/repos.example.json` as the template
