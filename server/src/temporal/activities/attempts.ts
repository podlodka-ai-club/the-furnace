import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDatabase, type Database } from "../../db/index.js";
import type { AttemptOutcome, AttemptPhase } from "../../db/types.js";

// Orchestrator-side activity that writes one row to the `attempts` table per
// invocation. Registered ONLY on the orchestrator worker — PGLite is in-process
// to the orchestrator, so per-repo container workers cannot reach it.
//
// Keyed by (run_id, phase, attempt_index) on the schema; multiple invocations
// with the same key are an upsert (later wins) so the workflow can record
// `pending` at start and overwrite with `passed`/`failed`/`stuck` at the end.

export const recordAttemptInputSchema = z.object({
  workflowId: z.string().min(1),
  phase: z.enum(["spec", "code", "coder", "review"]),
  attemptIndex: z.number().int().nonnegative(),
  outcome: z.enum([
    "pending",
    "passed",
    "failed",
    "stuck",
    "tests-green",
    "retry",
    "dep-missing",
    "design-question",
  ]),
});

export interface RecordAttemptInput {
  workflowId: string;
  phase: AttemptPhase;
  attemptIndex: number;
  outcome: AttemptOutcome;
}

let dbPromise: Promise<Database> | undefined;

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  const validated = recordAttemptInputSchema.parse(input);
  const db = await getDatabase();
  await db.transaction(async (tx) => {
    const runRows = await tx.query<{ id: string }>(
      "SELECT id FROM workflow_runs WHERE workflow_id = $1",
      [validated.workflowId],
    );
    if (runRows.length === 0) {
      throw new Error(`recordAttempt: no workflow_runs row for workflow_id=${validated.workflowId}`);
    }
    const runId = runRows[0].id;
    const finishedExpr = validated.outcome === "pending" ? "NULL" : "NOW()";
    await tx.query(
      `INSERT INTO attempts(id, run_id, phase, attempt_index, outcome, finished_at)
       VALUES ($1, $2, $3, $4, $5, ${finishedExpr})
       ON CONFLICT (run_id, phase, attempt_index)
       DO UPDATE SET outcome = EXCLUDED.outcome, finished_at = EXCLUDED.finished_at`,
      [randomUUID(), runId, validated.phase, validated.attemptIndex, validated.outcome],
    );
  });
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

// Internal helper for tests: reset the cached database promise so an explicit
// PGLITE_DATA_DIR override applies on the next call.
export function _resetAttemptsDb(): void {
  dbPromise = undefined;
}

// Internal helper for tests: returns the same cached database that
// `recordAttempt` uses, so tests can seed prerequisite rows (tickets,
// workflow_runs) without opening a sibling PGLite instance against the same
// dataDir (which would not see writes across siblings).
export async function _getAttemptsDb(): Promise<Database> {
  return getDatabase();
}
