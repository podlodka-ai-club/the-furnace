import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type Database } from "../../src/db/index.js";

const EXPECTED_KEYS: Record<string, string[]> = {
  tickets: ["external_id", "title", "ac_text", "label", "state", "cached_at"],
  workflow_runs: ["id", "workflow_id", "ticket_id", "status", "started_at", "finished_at"],
  attempts: [
    "id",
    "run_id",
    "phase",
    "attempt_index",
    "outcome",
    "started_at",
    "finished_at",
  ],
  reviews: ["id", "attempt_id", "persona", "vote", "reasoning", "created_at"],
  provenance: [
    "hash",
    "workflow_id",
    "model",
    "ticket_id",
    "attempt_index",
    "kind",
    "created_at",
  ],
};

describe("row types stay in sync with schema", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase({});
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
  });

  it("every table's introspected columns match the exported row interface keys", async () => {
    for (const [table, expected] of Object.entries(EXPECTED_KEYS)) {
      const rows = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [table],
      );
      const actual = rows.map((r) => r.column_name).sort();
      expect(actual).toEqual([...expected].sort());
    }
  });
});
