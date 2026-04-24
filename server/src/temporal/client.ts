import { Client, Connection } from "@temporalio/client";
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from "./config.js";

export async function createTemporalClient(): Promise<Client> {
  try {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    return new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  } catch (error) {
    throw new Error(
      `Unable to connect to Temporal at ${TEMPORAL_ADDRESS}. Start the local stack with 'docker compose up -d temporal temporal-ui' before running Temporal smoke tests.`,
      { cause: error },
    );
  }
}
