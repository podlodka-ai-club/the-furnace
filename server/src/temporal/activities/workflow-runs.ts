import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "../../db/index.js";
import type { WorkflowRunStatus } from "../../db/types.js";

export interface PersistWorkflowRunStartInput {
  workflowId: string;
  ticket: {
    id: string;
    identifier: string;
    title: string;
  };
}

export interface PersistWorkflowRunTransitionInput {
  workflowId: string;
  status: WorkflowRunStatus;
}

let dbPromise: Promise<Database> | undefined;

export async function persistWorkflowRunStart(input: PersistWorkflowRunStartInput): Promise<void> {
  const db = await getDatabase();
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO tickets(external_id, title, ac_text, label, state) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (external_id) DO UPDATE SET title = EXCLUDED.title",
      [input.ticket.id, input.ticket.title, "pending acceptance criteria", "agent-ready", "in-progress"],
    );

    await tx.query(
      "INSERT INTO workflow_runs(id, workflow_id, ticket_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (workflow_id) DO UPDATE SET status = EXCLUDED.status, finished_at = NULL",
      [randomUUID(), input.workflowId, input.ticket.id, "running"],
    );
  });
}

export async function persistWorkflowRunTransition(
  input: PersistWorkflowRunTransitionInput,
): Promise<void> {
  const db = await getDatabase();
  await db.query(
    "UPDATE workflow_runs SET status = $2, finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN NOW() ELSE NULL END WHERE workflow_id = $1",
    [input.workflowId, input.status],
  );
}

async function getDatabase(): Promise<Database> {
  if (dbPromise === undefined) {
    dbPromise = (async () => {
      const dataDir =
        process.env.PGLITE_DATA_DIR ??
        fileURLToPath(new URL("../../../../data/pglite/pgdata", import.meta.url));
      const db = await createDatabase({ dataDir });
      await db.migrate();
      return db;
    })();
  }

  return dbPromise;
}
