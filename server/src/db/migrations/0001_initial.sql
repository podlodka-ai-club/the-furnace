-- Core orchestration tables. See openspec/changes/data-model/design.md (D3).

CREATE TABLE tickets (
  external_id TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  ac_text     TEXT NOT NULL,
  label       TEXT NOT NULL,
  state       TEXT NOT NULL,
  cached_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE workflow_runs (
  id           UUID PRIMARY KEY,
  workflow_id  TEXT NOT NULL UNIQUE,
  ticket_id    TEXT NOT NULL REFERENCES tickets(external_id) ON DELETE RESTRICT,
  status       TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE attempts (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  phase         TEXT NOT NULL CHECK (phase IN ('spec','code','review')),
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
  outcome       TEXT NOT NULL CHECK (outcome IN ('pending','passed','failed','stuck')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (run_id, phase, attempt_index)
);

CREATE TABLE reviews (
  id          UUID PRIMARY KEY,
  attempt_id  UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  persona     TEXT NOT NULL CHECK (persona IN ('security','performance','architect','naming')),
  vote        TEXT NOT NULL CHECK (vote IN ('approve','reject','abstain')),
  reasoning   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, persona)
);

CREATE TABLE provenance (
  hash           TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL,
  model          TEXT NOT NULL,
  ticket_id      TEXT,
  attempt_index  INTEGER,
  kind           TEXT NOT NULL CHECK (kind IN ('tool_call','tool_result','message','diff')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX workflow_runs_ticket_id_idx ON workflow_runs(ticket_id);
CREATE INDEX attempts_run_id_idx         ON attempts(run_id);
CREATE INDEX reviews_attempt_id_idx      ON reviews(attempt_id);
CREATE INDEX provenance_workflow_id_idx  ON provenance(workflow_id);
CREATE INDEX provenance_ticket_id_idx    ON provenance(ticket_id);
