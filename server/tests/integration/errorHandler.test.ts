import { describe, it, expect, vi, afterEach } from "vitest";
import { Router } from "express";
import request from "supertest";
import { createApp } from "../../src/app.js";

function appWithThrowRoute(error: Error | (Error & { status: number })) {
  const router = Router();
  router.get("/", () => {
    throw error;
  });
  return createApp({ extraRouters: [{ path: "/__test/throw", router }] });
}

describe("error handler", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    errSpy.mockClear();
  });

  it("returns 500 with message and stack when NODE_ENV is unset", async () => {
    delete process.env.NODE_ENV;
    const app = appWithThrowRoute(new Error("boom"));
    const res = await request(app).get("/__test/throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error.message).toBe("boom");
    expect(typeof res.body.error.stack).toBe("string");
    expect(res.body.error.stack.length).toBeGreaterThan(0);
  });

  it("omits stack when NODE_ENV=production but keeps message", async () => {
    process.env.NODE_ENV = "production";
    const app = appWithThrowRoute(new Error("boom"));
    const res = await request(app).get("/__test/throw");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("boom");
    expect(res.body.error.stack).toBeUndefined();
  });

  it("honors err.status in the 400..599 range", async () => {
    delete process.env.NODE_ENV;
    const teapot = Object.assign(new Error("I'm a teapot"), { status: 418 });
    const app = appWithThrowRoute(teapot);
    const res = await request(app).get("/__test/throw");
    expect(res.status).toBe(418);
    expect(res.body.error.message).toBe("I'm a teapot");
  });
});
