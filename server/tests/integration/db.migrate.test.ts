import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../../src/db/migrate.js";
import { createDatabase, type Database } from "../../src/db/index.js";

describe("migration runner", () => {
  const open: Database[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      const db = open.pop();
      if (db) await db.close();
    }
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  async function scratchDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "furnace-migrate-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("fresh DB applies baseline migrations and creates all core tables", async () => {
    const db = await createDatabase({});
    open.push(db);
    const { applied } = await db.migrate();
    expect(applied).toEqual(["0001_initial", "0002_coder_attempt_outcomes"]);
    const rows = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const names = rows.map((r) => r.table_name);
    for (const expected of [
      "_migrations",
      "attempts",
      "provenance",
      "reviews",
      "tickets",
      "workflow_runs",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("is idempotent: second migrate returns empty applied", async () => {
    const db = await createDatabase({});
    open.push(db);
    const first = await db.migrate();
    expect(first.applied).toEqual(["0001_initial", "0002_coder_attempt_outcomes"]);
    const second = await db.migrate();
    expect(second.applied).toEqual([]);
  });

  describe("with scratch dirs", () => {
    let pg: PGlite;

    beforeEach(async () => {
      pg = new PGlite();
      await pg.waitReady;
    });

    afterEach(async () => {
      await pg.close();
    });

    it("applies files in lexical order regardless of mtime", async () => {
      const dir = await scratchDir();
      await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
      const { applied } = await runMigrations(pg, dir);
      expect(applied).toEqual(["0001_a", "0002_b"]);
      const versions = await pg.query<{ version: string }>(
        "SELECT version FROM _migrations ORDER BY applied_at ASC",
      );
      expect(versions.rows.map((r) => r.version)).toEqual(["0001_a", "0002_b"]);
    });

    it("rolls back a failing migration and preserves prior versions", async () => {
      const dir = await scratchDir();
      await writeFile(path.join(dir, "0001_good.sql"), "CREATE TABLE good (id INTEGER);");
      await writeFile(path.join(dir, "0002_bogus.sql"), "CREATE TABL bogus (id INTEGER);");
      await expect(runMigrations(pg, dir)).rejects.toThrow(/0002_bogus\.sql/);
      const versions = await pg.query<{ version: string }>(
        "SELECT version FROM _migrations ORDER BY version",
      );
      expect(versions.rows.map((r) => r.version)).toEqual(["0001_good"]);
      const good = await pg.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'good'",
      );
      expect(good.rows).toHaveLength(1);
    });
  });
});
