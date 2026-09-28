import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { setSessionCookie } from "../lib/auth.js";
import type { Session } from "../lib/auth.js";

declare global { namespace Express { interface Request { user?: Session } } }

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[env.COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    req.user = jwt.verify(token, env.JWT_SECRET) as Session;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired" });
  }
}

/**
 * Role guard.
 *
 * A buyer who deliberately enters the seller flow can become a
 * FREE seller without needing Premium. This also repairs an old
 * BUYER session left behind before the seller-flow promotion was
 * introduced. The new SELLER session cookie is issued immediately,
 * so the following product-upload request is authorized.
 *
 * Premium remains a separate subscription check and is not granted here.
 */
export const requireRole = (...roles: Session["role"][]) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (roles.includes(req.user.role)) {
    return next();
  }

  if (req.user.role === "BUYER" && roles.includes("SELLER")) {
    try {
      const user = await prisma.user.update({
        where: { id: req.user.userId },
        data: { role: "SELLER" },
      });

      const session: Session = {
        userId: user.id,
        role: "SELLER",
      };

      setSessionCookie(res, session);
      req.user = session;
      return next();
    } catch {
      return res.status(403).json({ error: "Unable to activate seller access" });
    }
  }

  return res.status(403).json({ error: "Insufficient permissions" });
};
