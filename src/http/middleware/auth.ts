import type { Request, RequestHandler } from "express";
import type { Db } from "../../db/client.js";
import { AppError } from "../../errors.js";
import { findAccountByApiKey } from "../../services/accounts.js";
import { asyncHandler } from "../errors.js";

export interface AuthAccount {
  id: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      account?: AuthAccount;
    }
  }
}

/**
 * Authenticates the calling application via the X-API-Key header.
 * On success, req.account is the ONLY source of truth for "which account is calling".
 */
export function requireApiKey(db: Db): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const rawKey = req.header("x-api-key");
    if (!rawKey) {
      throw new AppError(401, "MISSING_API_KEY", "Missing X-API-Key header.");
    }
    const account = await findAccountByApiKey(db, rawKey);
    if (!account) {
      throw new AppError(401, "INVALID_API_KEY", "Invalid API key.");
    }
    req.account = account;
    next();
  });
}

export function currentAccount(req: Request): AuthAccount {
  if (!req.account) throw new AppError(401, "MISSING_API_KEY", "Authentication required.");
  return req.account;
}
