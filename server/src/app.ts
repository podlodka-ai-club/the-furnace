import express, { type Express, type Router } from "express";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import type { Database } from "./db/index.js";

export interface CreateAppOptions {
  db?: Database;
  extraRouters?: Array<{ path: string; router: Router }>;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  if (options.db !== undefined) {
    app.locals.db = options.db;
  }
  app.use(express.json());
  app.use(requestLogger);
  app.use("/health", healthRouter());
  for (const { path, router } of options.extraRouters ?? []) {
    app.use(path, router);
  }
  app.use(errorHandler);
  return app;
}
