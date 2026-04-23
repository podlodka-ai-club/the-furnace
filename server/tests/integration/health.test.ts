import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { Server } from "node:http";
import { createApp } from "../../src/app.js";

describe("GET /health", () => {
  it("returns 200, status ok, and a non-negative integer uptimeMs", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.status).toBe("ok");
    expect(Number.isInteger(res.body.uptimeMs)).toBe(true);
    expect(res.body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("produces strictly increasing uptimeMs across successive calls 50ms apart", async () => {
    const app = createApp();
    const first = await request(app).get("/health");
    await new Promise((r) => setTimeout(r, 50));
    const second = await request(app).get("/health");
    expect(second.body.uptimeMs).toBeGreaterThan(first.body.uptimeMs);
  });

  it("createApp() returns a port-less Express app (no TCP bind)", () => {
    const app = createApp();
    expect(app).not.toBeInstanceOf(Server);
    const appAsServerShape = app as unknown as { address?: unknown; listening?: unknown };
    expect(typeof appAsServerShape.address).toBe("undefined");
    expect(typeof appAsServerShape.listening).toBe("undefined");
  });

  it("returns two independent Express instances across calls", () => {
    const a = createApp();
    const b = createApp();
    expect(a).not.toBe(b);
    expect((a as unknown as { _router: unknown })._router).not.toBe(
      (b as unknown as { _router: unknown })._router,
    );
  });

  it("logs exactly one line in the expected format for GET /health", async () => {
    const app = createApp();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await request(app).get("/health");
      const matches = spy.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => /^GET \/health 200 \d+ms$/.test(line));
      expect(matches).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
