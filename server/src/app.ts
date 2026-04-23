import express, { type Express, type Router } from "express";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";

export interface CreateAppOptions {
  extraRouters?: Array<{ path: string; router: Router }>;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);
  app.use("/health", healthRouter());
  for (const { path, router } of options.extraRouters ?? []) {
    app.use(path, router);
  }
  app.use(errorHandler);
  return app;
}
