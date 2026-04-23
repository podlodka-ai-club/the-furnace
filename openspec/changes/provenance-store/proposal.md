## Why

Concept §2 specifies content-addressed tool-output storage plus structured commit trailers. Together they enable "why did you do that?" queries against any merged commit and deterministic replay of the reasoning path. Without this, provenance is folklore.

## What Changes

- Add a content-addressed blob store backed by:
  - Local filesystem in dev (`data/provenance/<hash-prefix>/<hash>`).
  - S3-compatible object storage in prod (pluggable via `PROVENANCE_BACKEND=fs|s3`).
- Add `server/src/provenance/store.ts` with:
  - `put(bytes, metadata): Promise<hash>` — writes the blob, records a row in the `provenance` table with workflow metadata.
  - `get(hash): Promise<{ bytes, metadata }>` — read-through by hash.
  - `listByWorkflow(workflowId): Promise<ProvenanceRecord[]>` — used by future "why did you do that?" queries.
- Wire each agent activity (spec, coder, reviewers) to put every tool output through the store, tagged with `{ workflowId, model, ticketId, attemptIndex, kind }`.
- Store returns the hash; the hash is included in commit trailers so every merged commit points at its provenance record.

## Capabilities

### New Capabilities

- `provenance-storage`: Content-addressed tool-output store plus workflow-metadata index supporting per-workflow recall and trailer-linkable audit.

### Modified Capabilities

- `spec-generation`, `code-generation`, `multi-persona-review`: Each tool output is written through the store before being consumed downstream.
- `github-pr-lifecycle`: Commit trailers now include a `Provenance-Hash:` field.

## Impact

- New files: `server/src/provenance/store.ts`, `server/src/provenance/backends/{fs,s3}.ts`, `server/tests/integration/provenance.test.ts`.
- New env vars: `PROVENANCE_BACKEND`, `PROVENANCE_S3_BUCKET` (prod only).
- Uses the `provenance` table from `data-model`.
- No retention policy yet — explicit V1+ concern per concept §5.
