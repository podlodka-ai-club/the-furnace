import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

describe("HTTP startup does not require Claude worker auth", () => {
  it("createApp() resolves without ANTHROPIC_API_KEY or CLAUDE_CREDS_DIR set", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalCreds = process.env.CLAUDE_CREDS_DIR;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CREDS_DIR;
    try {
      const app = await createApp({ skipTicketActivityRouter: true, skipUi: true });
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    } finally {
      if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalCreds !== undefined) process.env.CLAUDE_CREDS_DIR = originalCreds;
    }
  });

  it("server entry point does not import or call assertWorkerAuthAvailable", async () => {
    const fs = await import("node:fs/promises");
    const indexSrc = await fs.readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(indexSrc).not.toMatch(/assertWorkerAuthAvailable\(/);
  });
});
