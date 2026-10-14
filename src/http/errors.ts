import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { AppError } from "../errors.js";

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** Lets async route handlers throw: rejected promises are forwarded to the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Validates untrusted input with a Zod schema; throws a 400 AppError on failure. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw new AppError(400, "VALIDATION_ERROR", "Request validation failed.", details);
  }
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(errorBody("ROUTE_NOT_FOUND", "Route not found."));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json(errorBody(err.code, err.message, err.details));
    return;
  }

  // Errors raised by express.json()
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.parse.failed") {
    res.status(400).json(errorBody("INVALID_JSON", "Request body is not valid JSON."));
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json(errorBody("PAYLOAD_TOO_LARGE", "Request body is too large."));
    return;
  }

  // Unexpected: log it for us, hide the details from the caller.
  console.error("Unhandled error:", err);
  res.status(500).json(errorBody("INTERNAL_ERROR", "Internal server error."));
};
