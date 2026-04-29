import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { Database } from "../../src/db/index.js";
import {
  recordAttempt,
  _resetAttemptsDb,
  _getAttemptsDb,
} from "../../src/temporal/activities/attempts.js";

describe("recordAttempt activity", () => {
  let db: Database;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "furnace-attempts-"));
    originalDataDir = process.env.PGLITE_DATA_DIR;
    process.env.PGLITE_DATA_DIR = dataDir;
    _resetAttemptsDb();
    db = await _getAttemptsDb();
    await db.query(
      "INSERT INTO tickets(external_id, title, ac_text, label, state) VALUES ($1, $2, $3, $4, $5)",
      ["ENG-1", "title", "ac", "agent-ready", "todo"],
    );
  });

  afterEach(async () => {
    await db.close();
    if (originalDataDir === undefined) {
      delete process.env.PGLITE_DATA_DIR;
    } else {
      process.env.PGLITE_DATA_DIR = originalDataDir;
    }
    _resetAttemptsDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function insertRun(workflowId: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      "INSERT INTO workflow_runs(id, workflow_id, ticket_id, status) VALUES ($1, $2, $3, $4)",
      [id, workflowId, "ENG-1", "pending"],
    );
    return id;
  }

  it("inserts a row keyed by (run_id, phase, attempt_index) with finished_at NULL when pending", async () => {
    const runId = await insertRun("wf-pending");
    await recordAttempt({
      workflowId: "wf-pending",
      phase: "spec",
      attemptIndex: 0,
      outcome: "pending",
    });
    const rows = await db.query<{
      run_id: string;
      phase: string;
      attempt_index: number;
      outcome: string;
      finished_at: string | null;
    }>("SELECT run_id, phase, attempt_index, outcome, finished_at FROM attempts WHERE run_id = $1", [
      runId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("spec");
    expect(rows[0].attempt_index).toBe(0);
    expect(rows[0].outcome).toBe("pending");
    expect(rows[0].finished_at).toBeNull();
  });

  it.each(["passed", "failed", "stuck"] as const)(
    "sets finished_at to NOW() on terminal outcome %s",
    async (outcome) => {
      const runId = await insertRun(`wf-${outcome}`);
      await recordAttempt({
        workflowId: `wf-${outcome}`,
        phase: "spec",
        attemptIndex: 0,
        outcome,
      });
      const rows = await db.query<{ outcome: string; finished_at: string | null }>(
        "SELECT outcome, finished_at FROM attempts WHERE run_id = $1",
        [runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe(outcome);
      expect(rows[0].finished_at).not.toBeNull();
    },
  );

  it("upserts (run_id, phase, attempt_index) — pending then passed overwrites in place", async () => {
    const runId = await insertRun("wf-upsert");
    await recordAttempt({
      workflowId: "wf-upsert",
      phase: "spec",
      attemptIndex: 0,
      outcome: "pending",
    });
    await recordAttempt({
      workflowId: "wf-upsert",
      phase: "spec",
      attemptIndex: 0,
      outcome: "passed",
    });
    const rows = await db.query<{ outcome: string; finished_at: string | null }>(
      "SELECT outcome, finished_at FROM attempts WHERE run_id = $1",
      [runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("passed");
    expect(rows[0].finished_at).not.toBeNull();
  });

  it("throws when no workflow_runs row matches the workflowId", async () => {
    await expect(
      recordAttempt({
        workflowId: "wf-missing",
        phase: "spec",
        attemptIndex: 0,
        outcome: "pending",
      }),
    ).rejects.toThrow(/no workflow_runs row/);
  });

  it("rejects invalid input (zod)", async () => {
    await expect(
      recordAttempt({
        workflowId: "",
        phase: "spec",
        attemptIndex: 0,
        outcome: "pending",
      }),
    ).rejects.toThrow();
    await expect(
      recordAttempt({
        workflowId: "wf-x",
        // @ts-expect-error invalid phase
        phase: "deploy",
        attemptIndex: 0,
        outcome: "pending",
      }),
    ).rejects.toThrow();
  });
});
