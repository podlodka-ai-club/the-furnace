import { describe, it, expect, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import { createDatabase, type Database } from "../../src/db/index.js";

const DATA_DIR = new URL("../../../data/pglite/", import.meta.url);

async function snapshotDir(url: URL): Promise<string[]> {
  try {
    return (await readdir(url)).sort();
  } catch {
    return [];
  }
}

describe("createDatabase", () => {
  const open: Database[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      const db = open.pop();
      if (db) await db.close();
    }
  });

  it("returns a handle and runs SELECT 1 without touching data/pglite", async () => {
    const before = await snapshotDir(DATA_DIR);
    const db = await createDatabase({});
    open.push(db);
    const rows = await db.query<{ n: number }>("SELECT 1 AS n");
    expect(rows).toEqual([{ n: 1 }]);
    const after = await snapshotDir(DATA_DIR);
    expect(after).toEqual(before);
  });

  it("returns distinct instances across calls", async () => {
    const a = await createDatabase({});
    const b = await createDatabase({});
    open.push(a, b);
    expect(a).not.toBe(b);
    await a.exec("CREATE TABLE isolated (x INTEGER)");
    const rowsA = await a.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'isolated'",
    );
    const rowsB = await b.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'isolated'",
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
  });
});
