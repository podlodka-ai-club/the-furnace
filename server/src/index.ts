import type { Server } from "node:http";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  // Note: HTTP startup intentionally does NOT call `assertWorkerAuthAvailable`.
  // Claude worker credentials are only required to launch per-attempt
  // containers; the dev server (UI shell, /health, read-only API routes) must
  // boot without them. Worker auth is still enforced in
  // `runTemporalWorker()` (see `temporal/worker.ts`) and at container launch
  // time inside `worker-launcher.ts`.
  const port = Number(process.env.PORT) || 3000;
  const app = await createApp();
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
