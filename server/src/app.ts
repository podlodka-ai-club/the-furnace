import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Router } from "express";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { createTicketActivityRouter } from "./routes/ticket-activity.js";
import { createTemporalClient } from "./temporal/client.js";
import { TEMPORAL_NAMESPACE, TEMPORAL_WEB_BASE } from "./temporal/config.js";
import {
  createTicketActivityService,
  type TicketActivityService,
} from "./temporal/ticket-activity-service.js";

export interface CreateAppOptions {
  extraRouters?: Array<{ path: string; router: Router }>;
  // Inject a pre-built ticket activity service (used by tests).
  ticketActivityService?: TicketActivityService;
  // When `true`, do not auto-create a Temporal-backed service if none is
  // injected. Tests use this to avoid hitting Temporal during boot.
  skipTicketActivityRouter?: boolean;
  // When `true`, do not mount UI serving (static or Vite middleware).
  skipUi?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);
  app.use("/health", healthRouter());

  const ticketActivityService = await resolveTicketActivityService(options);
  if (ticketActivityService) {
    app.use("/api/ticket-workflows", createTicketActivityRouter(ticketActivityService));
  }

  for (const { path: routerPath, router } of options.extraRouters ?? []) {
    app.use(routerPath, router);
  }

  // Any /api/* not matched above must return JSON 404 so the Vite SPA
  // fallback below never serves HTML for missing API routes.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { message: "Not Found", code: "not_found" } });
  });

  if (!options.skipUi) {
    await mountUi(app);
  }

  app.use(errorHandler);
  return app;
}

async function resolveTicketActivityService(
  options: CreateAppOptions,
): Promise<TicketActivityService | undefined> {
  if (options.ticketActivityService) return options.ticketActivityService;
  if (options.skipTicketActivityRouter) return undefined;
  try {
    const client = await createTemporalClient();
    return createTicketActivityService({
      client,
      namespace: TEMPORAL_NAMESPACE,
      temporalWebBase: TEMPORAL_WEB_BASE,
    });
  } catch (err) {
    console.warn(
      `Ticket activity API disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function mountUi(app: Express): Promise<void> {
  const mode = process.env.NODE_ENV ?? "development";
  if (mode === "development") {
    await mountDevUi(app);
    return;
  }
  mountProdUi(app);
}

async function mountDevUi(app: Express): Promise<void> {
  try {
    const vite = await import("vite");
    const serverHere = path.dirname(fileURLToPath(import.meta.url));
    const configFile = path.resolve(serverHere, "..", "vite.config.ts");
    const server = await vite.createServer({
      configFile,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(server.middlewares);
  } catch (err) {
    console.warn(
      `Vite dev middleware unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function mountProdUi(app: Express): void {
  const serverHere = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(serverHere, "..", "ui");
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/|health(?:\/|$)).*/, (_req, res, next) => {
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}
