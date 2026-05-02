import type { Server } from "node:http";
import { createApp } from "./app.js";
import { assertWorkerAuthAvailable } from "./worker-launcher.js";

async function main(): Promise<void> {
  await assertWorkerAuthAvailable();

  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  const server: Server = app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
