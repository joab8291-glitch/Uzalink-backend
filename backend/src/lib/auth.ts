import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env } from "./config.js";

export type Session = { userId: string; role: "BUYER" | "SELLER" | "ADMIN" };
export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
export const signSession = (session: Session) => jwt.sign(session, env.JWT_SECRET, { expiresIn: "7d" });
export function setSessionCookie(res: Response, session: Session) {
  res.cookie(env.COOKIE_NAME, signSession(session), { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
}
