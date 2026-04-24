import { describe, expect, it } from "vitest";
import { formatWorkflowDeepLinkSection } from "../src/linear/client.js";

describe("formatWorkflowDeepLinkSection", () => {
  it("formats workflow context heading and link", () => {
    const section = formatWorkflowDeepLinkSection("https://furnace.local/workflows/run-123");

    expect(section).toContain("## Workflow context");
    expect(section).toContain("https://furnace.local/workflows/run-123");
    expect(section).toContain("Review the execution details");
  });
});
