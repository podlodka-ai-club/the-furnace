import { describe, it, expect, afterEach } from "vitest";
import { Router } from "express";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabase, type Database } from "../../src/db/index.js";

describe("createApp({ db })", () => {
  const open: Database[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      const db = open.pop();
      if (db) await db.close();
    }
  });

  it("exposes db on req.app.locals.db as the same instance", async () => {
    const db = await createDatabase({});
    open.push(db);

    const matches: boolean[] = [];
    const router = Router();
    router.get("/", (req, res) => {
      const localsDb = req.app.locals.db;
      matches.push(localsDb === db);
      res.status(200).json({ kind: typeof localsDb });
    });

    const app = createApp({ db, extraRouters: [{ path: "/__test/db", router }] });
    const res = await request(app).get("/__test/db");
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("object");
    expect(matches).toEqual([true]);
  });

  it("omits db from locals when not provided (foundation compatibility)", () => {
    const app = createApp();
    expect(app.locals.db).toBeUndefined();
  });
});
