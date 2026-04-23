import type { Request, Response, NextFunction } from "express";

interface HttpError extends Error {
  status?: unknown;
}

function resolveStatus(status: unknown): number {
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }
  return 500;
}

export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(err);
  const status = resolveStatus(err.status);
  const message = typeof err.message === "string" ? err.message : "Internal Server Error";
  const body: { error: { message: string; stack?: string } } = {
    error: { message },
  };
  if (process.env.NODE_ENV !== "production" && typeof err.stack === "string") {
    body.error.stack = err.stack;
  }
  res.status(status).json(body);
}
