import { afterEach } from "vitest";
import type { Client } from "@temporalio/client";
import { createTemporalClient } from "../../../src/temporal/client.js";

// Integration tests must construct workflow IDs that contain a literal `test-`
// segment so this cleanup hook can match them unambiguously. Two prefixes are
// allowed:
//
//   - `test-...`        — workflows started directly by tests (pollers, hello,
//                         ticket-workflow direct starts, etc.).
//   - `ticket-test-...` — per-ticket workflows that the linear poller spawns
//                         when the test feeds it a ticket whose ID starts with
//                         `test-`. `buildPerTicketWorkflowId` prepends
//                         `ticket-`, producing `ticket-test-...`.
//
// Production workflow IDs never contain `test-`, so this cleanup cannot
// terminate real workflows by accident.
const TEST_WORKFLOW_PREFIXES = ["test-", "ticket-test-"] as const;

const RUNNING_TEST_WORKFLOWS_QUERY = `ExecutionStatus="Running" AND (${TEST_WORKFLOW_PREFIXES
  .map((p) => `WorkflowId STARTS_WITH "${p}"`)
  .join(" OR ")})`;

export function installWorkflowCleanupHook(): void {
  afterEach(async () => {
    let client: Client;
    try {
      client = await createTemporalClient();
    } catch {
      return;
    }

    const ids: string[] = [];
    try {
      for await (const wf of client.workflow.list({ query: RUNNING_TEST_WORKFLOWS_QUERY })) {
        ids.push(wf.workflowId);
      }
    } catch {
      return;
    }

    await Promise.allSettled(
      ids.map((id) =>
        client.workflow
          .getHandle(id)
          .terminate("integration test cleanup")
          .catch(() => undefined),
      ),
    );
  });
}
