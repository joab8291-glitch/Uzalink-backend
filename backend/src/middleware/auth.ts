import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/config.js";
import type { Session } from "../lib/auth.js";

declare global { namespace Express { interface Request { user?: Session } } }

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[env.COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try { req.user = jwt.verify(token, env.JWT_SECRET) as Session; next(); }
  catch { return res.status(401).json({ error: "Session expired" }); }
}
export const requireRole = (...roles: Session["role"][]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
  next();
};
