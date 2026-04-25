import { createLinearClient } from "../../linear/client.js";
import type { Ticket } from "../../linear/types.js";

export async function listAgentReadyTicketsActivity(): Promise<Ticket[]> {
  const client = createLinearClient();
  return client.listAgentReadyTickets();
}
