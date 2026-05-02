import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "../../src/db/index.js";
import {
  persistWorkflowRunStart,
  _getWorkflowRunsDb,
  _resetWorkflowRunsDb,
} from "../../src/temporal/activities/workflow-runs.js";

describe("persistWorkflowRunStart activity", () => {
  let db: Database;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "furnace-persist-runs-"));
    originalDataDir = process.env.PGLITE_DATA_DIR;
    process.env.PGLITE_DATA_DIR = dataDir;
    _resetWorkflowRunsDb();
    db = await _getWorkflowRunsDb();
  });

  afterEach(async () => {
    await db.close();
    _resetWorkflowRunsDb();
    if (originalDataDir === undefined) {
      delete process.env.PGLITE_DATA_DIR;
    } else {
      process.env.PGLITE_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes ticket.description into tickets.ac_text on insert", async () => {
    await persistWorkflowRunStart({
      workflowId: "ticket-issue_1",
      ticket: {
        id: "issue_1",
        identifier: "ENG-1",
        title: "First ticket",
        description: "Original description body",
      },
    });

    const rows = await db.query<{ ac_text: string; title: string }>(
      "SELECT ac_text, title FROM tickets WHERE external_id = $1",
      ["issue_1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ac_text).toBe("Original description body");
    expect(rows[0].title).toBe("First ticket");
  });

  it("overwrites tickets.ac_text on re-poll with edited description", async () => {
    await persistWorkflowRunStart({
      workflowId: "ticket-issue_2",
      ticket: {
        id: "issue_2",
        identifier: "ENG-2",
        title: "Editable ticket",
        description: "Initial description",
      },
    });

    await persistWorkflowRunStart({
      workflowId: "ticket-issue_2",
      ticket: {
        id: "issue_2",
        identifier: "ENG-2",
        title: "Editable ticket (renamed)",
        description: "Edited description after re-poll",
      },
    });

    const rows = await db.query<{ ac_text: string; title: string }>(
      "SELECT ac_text, title FROM tickets WHERE external_id = $1",
      ["issue_2"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ac_text).toBe("Edited description after re-poll");
    expect(rows[0].title).toBe("Editable ticket (renamed)");
  });

  it("persists empty-string description without erroring", async () => {
    await persistWorkflowRunStart({
      workflowId: "ticket-issue_3",
      ticket: {
        id: "issue_3",
        identifier: "ENG-3",
        title: "Empty description ticket",
        description: "",
      },
    });

    const rows = await db.query<{ ac_text: string }>(
      "SELECT ac_text FROM tickets WHERE external_id = $1",
      ["issue_3"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ac_text).toBe("");
  });
});
