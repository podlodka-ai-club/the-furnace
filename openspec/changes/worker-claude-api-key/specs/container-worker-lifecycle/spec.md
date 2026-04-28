## MODIFIED Requirements

### Requirement: Container worker authenticates Claude via host-supplied OAuth token, API key, or mounted credentials

The system SHALL bind-mount the host's `~/.claude` directory (or the directory named by `CLAUDE_CREDS_DIR`) read-only at `/root/.claude` for every worker container. This mount provides operator-level Claude settings, registered agents, MCP server configuration, and (on Linux) subscription credentials.

In addition, when `CLAUDE_CODE_OAUTH_TOKEN` is set in the orchestrator's `process.env` (typically loaded from `server/.env` via the existing `tsx --env-file=.env` flag in the npm boot scripts), the launcher MUST forward it to the container via `docker run --env CLAUDE_CODE_OAUTH_TOKEN`. Likewise, when `ANTHROPIC_API_KEY` is set, the launcher MUST forward it via `docker run --env ANTHROPIC_API_KEY`. Either or both MAY be set; both are purely additive — they do not replace or alter the bind-mount, and the Claude Agent SDK's own resolution order picks one when multiple are present.

The orchestrator MUST validate at startup that at least one viable auth source is available — `CLAUDE_CODE_OAUTH_TOKEN` is set in `process.env`, OR `ANTHROPIC_API_KEY` is set in `process.env`, OR the resolved credentials directory exists and is non-empty — and MUST fail fast with a single-line actionable message naming all three options if none is. No other host paths beyond the worker bundle and the credentials directory are mounted.

#### Scenario: OAuth token is forwarded alongside the credentials mount

- **WHEN** the orchestrator launches a worker container with `CLAUDE_CODE_OAUTH_TOKEN` set in its `process.env` (e.g., loaded from `server/.env`)
- **THEN** the resulting `docker run` invocation includes both `--env CLAUDE_CODE_OAUTH_TOKEN` and a read-only bind-mount of the host credentials directory at `/root/.claude`

#### Scenario: API key env var is forwarded alongside the credentials mount

- **WHEN** the orchestrator launches a worker container with `ANTHROPIC_API_KEY` set in its `process.env` (e.g., loaded from `server/.env`)
- **THEN** the resulting `docker run` invocation includes both `--env ANTHROPIC_API_KEY` and a read-only bind-mount of the host credentials directory at `/root/.claude`

#### Scenario: Both auth env vars are forwarded when both are set

- **WHEN** the orchestrator launches a worker container with BOTH `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` set in its `process.env`
- **THEN** the resulting `docker run` invocation includes both `--env CLAUDE_CODE_OAUTH_TOKEN` and `--env ANTHROPIC_API_KEY`, plus the read-only bind-mount of the host credentials directory

#### Scenario: Credentials directory is mounted when no auth env var is set

- **WHEN** the orchestrator launches a worker container with both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` unset and a non-empty `~/.claude` (or `CLAUDE_CREDS_DIR`) on the host
- **THEN** the resulting `docker run` invocation bind-mounts that directory read-only at `/root/.claude` and does not pass either env var

#### Scenario: Orchestrator startup fails when no auth source is available

- **WHEN** the orchestrator process starts with `CLAUDE_CODE_OAUTH_TOKEN` unset AND `ANTHROPIC_API_KEY` unset AND the resolved credentials directory missing or empty
- **THEN** the orchestrator exits non-zero with a single-line error naming `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, and the expected credentials directory, before any worker container is launched

#### Scenario: No additional host filesystem leaks into the container

- **WHEN** a worker container is launched
- **THEN** the only host bind-mounts are the orchestrator's worker bundle directory (read-only) and the Claude credentials directory (read-only); no other host paths are exposed
