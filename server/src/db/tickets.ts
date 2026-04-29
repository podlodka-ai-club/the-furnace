import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "./index.js";

// Lookup helper used by activities that need ticket details (title +
// acceptance-criteria text) at runtime. The orchestrator stores these via
// `persistWorkflowRunStart` when a workflow starts; this read path is the
// inverse used by the spec activity to seed its prompt.

let dbPromise: Promise<Database> | undefined;

export interface TicketLookupRow {
  id: string;
  title: string;
  description: string;
}

export async function fetchTicketFromDb(externalId: string): Promise<TicketLookupRow | null> {
  const db = await getDatabase();
  const rows = await db.query<{ external_id: string; title: string; ac_text: string }>(
    "SELECT external_id, title, ac_text FROM tickets WHERE external_id = $1",
    [externalId],
  );
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  return {
    id: row.external_id,
    title: row.title,
    description: row.ac_text,
  };
}

async function getDatabase(): Promise<Database> {
  if (dbPromise === undefined) {
    dbPromise = (async () => {
      const dataDir =
        process.env.PGLITE_DATA_DIR ??
        fileURLToPath(new URL("../../../data/pglite/pgdata", import.meta.url));
      const db = await createDatabase({ dataDir });
      await db.migrate();
      return db;
    })();
  }
  return dbPromise;
}
