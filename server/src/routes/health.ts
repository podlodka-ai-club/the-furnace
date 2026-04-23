import { Router } from "express";

export function healthRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.status(200).json({
      status: "ok",
      uptimeMs: Math.floor(process.uptime() * 1000),
    });
  });
  return router;
}
