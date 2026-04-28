import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createDatabase, type Database } from "./db/index.js";
import { assertWorkerAuthAvailable } from "./worker-launcher.js";

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    throw new Error("prod driver not wired up yet — tracked for the deploy change");
  }

  await assertWorkerAuthAvailable();

  const dataDir = fileURLToPath(new URL("../../data/pglite/pgdata", import.meta.url));
  const db: Database = await createDatabase({ dataDir });
  const { applied } = await db.migrate();
  console.log(`Migrations applied: ${applied.length === 0 ? "(none)" : applied.join(", ")}`);

  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ db });
  const server: Server = app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
