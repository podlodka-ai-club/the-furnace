import { proxyActivities } from "@temporalio/workflow";
import type * as helloActivities from "../activities/hello.js";

export const HELLO_WORKFLOW_NAME = "helloWorkflow";

const { helloActivity } = proxyActivities<typeof helloActivities>({
  startToCloseTimeout: "30 seconds",
});

export async function helloWorkflow(name: string): Promise<string> {
  return helloActivity(name);
}
