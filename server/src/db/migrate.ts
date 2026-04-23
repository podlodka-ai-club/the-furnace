import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

export interface MigrationRunResult {
  applied: string[];
}

export async function runMigrations(
  db: PGlite,
  migrationsDir: string | URL,
): Promise<MigrationRunResult> {
  const dirPath =
    typeof migrationsDir === "string" ? migrationsDir : fileURLToPath(migrationsDir);

  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  );

  const entries = await readdir(dirPath);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();

  const applied: string[] = [];
  for (const file of sqlFiles) {
    const version = file.replace(/\.sql$/, "");
    const existing = await db.query<{ version: string }>(
      "SELECT version FROM _migrations WHERE version = $1",
      [version],
    );
    if (existing.rows.length > 0) continue;

    const sql = await readFile(`${dirPath}/${file}`, "utf8");
    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query("INSERT INTO _migrations(version) VALUES ($1)", [version]);
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${file} failed: ${cause}`, { cause: err });
    }
    applied.push(version);
  }

  return { applied };
}
