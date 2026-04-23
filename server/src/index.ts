import type { Server } from "node:http";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
const app = createApp();
const server: Server = app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
