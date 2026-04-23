import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../../src/db/index.js";

describe("initial schema constraints", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase({});
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertTicket(id: string): Promise<void> {
    await db.query(
      "INSERT INTO tickets(external_id, title, ac_text, label, state) VALUES ($1, $2, $3, $4, $5)",
      [id, "title", "ac", "agent-ready", "todo"],
    );
  }

  async function insertRun(ticketId: string, opts?: { workflowId?: string }): Promise<string> {
    const id = randomUUID();
    await db.query(
      "INSERT INTO workflow_runs(id, workflow_id, ticket_id, status) VALUES ($1, $2, $3, $4)",
      [id, opts?.workflowId ?? `wf-${id}`, ticketId, "pending"],
    );
    return id;
  }

  async function insertAttempt(
    runId: string,
    opts?: { phase?: string; attemptIndex?: number; outcome?: string },
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      "INSERT INTO attempts(id, run_id, phase, attempt_index, outcome) VALUES ($1, $2, $3, $4, $5)",
      [id, runId, opts?.phase ?? "spec", opts?.attemptIndex ?? 0, opts?.outcome ?? "pending"],
    );
    return id;
  }

  it("tickets→workflow_runs: reference works and workflow_id is UNIQUE", async () => {
    await insertTicket("ENG-1");
    await insertRun("ENG-1", { workflowId: "wf-a" });
    await expect(insertRun("ENG-1", { workflowId: "wf-a" })).rejects.toThrow();
  });

  it("workflow_runs.status CHECK rejects bogus value", async () => {
    await insertTicket("ENG-2");
    await expect(
      db.query(
        "INSERT INTO workflow_runs(id, workflow_id, ticket_id, status) VALUES ($1, $2, $3, $4)",
        [randomUUID(), "wf-x", "ENG-2", "bogus"],
      ),
    ).rejects.toThrow();
  });

  it("attempts UNIQUE(run_id, phase, attempt_index) rejects duplicates", async () => {
    await insertTicket("ENG-3");
    const runId = await insertRun("ENG-3");
    await insertAttempt(runId, { phase: "spec", attemptIndex: 0 });
    await expect(
      insertAttempt(runId, { phase: "spec", attemptIndex: 0 }),
    ).rejects.toThrow();
    await insertAttempt(runId, { phase: "spec", attemptIndex: 1 });
  });

  it("reviews CHECK + UNIQUE enforced", async () => {
    await insertTicket("ENG-4");
    const runId = await insertRun("ENG-4");
    const attemptId = await insertAttempt(runId);
    await db.query(
      "INSERT INTO reviews(id, attempt_id, persona, vote, reasoning) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), attemptId, "security", "approve", "ok"],
    );
    await expect(
      db.query(
        "INSERT INTO reviews(id, attempt_id, persona, vote, reasoning) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), attemptId, "security", "reject", "dup"],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO reviews(id, attempt_id, persona, vote, reasoning) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), attemptId, "bad-persona", "approve", "x"],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO reviews(id, attempt_id, persona, vote, reasoning) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), attemptId, "performance", "maybe", "x"],
      ),
    ).rejects.toThrow();
  });

  it("provenance PK on hash rejects duplicate; CHECK rejects bad kind", async () => {
    await db.query(
      "INSERT INTO provenance(hash, workflow_id, model, kind) VALUES ($1, $2, $3, $4)",
      ["h1", "wf-p", "claude-opus-4-7", "message"],
    );
    await expect(
      db.query(
        "INSERT INTO provenance(hash, workflow_id, model, kind) VALUES ($1, $2, $3, $4)",
        ["h1", "wf-p", "claude-opus-4-7", "message"],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO provenance(hash, workflow_id, model, kind) VALUES ($1, $2, $3, $4)",
        ["h2", "wf-p", "claude-opus-4-7", "bogus"],
      ),
    ).rejects.toThrow();
  });

  it("cascade on workflow_runs deletes attempts and reviews; RESTRICT on tickets with runs", async () => {
    await insertTicket("ENG-5");
    const runId = await insertRun("ENG-5");
    const attemptId = await insertAttempt(runId);
    await db.query(
      "INSERT INTO reviews(id, attempt_id, persona, vote, reasoning) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), attemptId, "architect", "approve", "ok"],
    );

    await expect(
      db.query("DELETE FROM tickets WHERE external_id = $1", ["ENG-5"]),
    ).rejects.toThrow();

    await db.query("DELETE FROM workflow_runs WHERE id = $1", [runId]);
    const attempts = await db.query<{ id: string }>(
      "SELECT id FROM attempts WHERE run_id = $1",
      [runId],
    );
    expect(attempts).toHaveLength(0);
    const reviews = await db.query<{ id: string }>(
      "SELECT id FROM reviews WHERE attempt_id = $1",
      [attemptId],
    );
    expect(reviews).toHaveLength(0);

    await db.query("DELETE FROM tickets WHERE external_id = $1", ["ENG-5"]);
    const remaining = await db.query<{ external_id: string }>(
      "SELECT external_id FROM tickets WHERE external_id = $1",
      ["ENG-5"],
    );
    expect(remaining).toHaveLength(0);
  });
});
