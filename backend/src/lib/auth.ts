import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env } from "./config.js";

export type Session = {
  userId: string;
  role: "BUYER" | "SELLER" | "ADMIN";
};

/**
 * Hash a magic-link token before storing or looking it up.
 */
export const hashToken = (token: string): string =>
  crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

/**
 * Generate a cryptographically secure random token.
 */
export const randomToken = (
  bytes = 32
): string =>
  crypto
    .randomBytes(bytes)
    .toString("hex");

/**
 * Create the JWT used for the authenticated session.
 */
export const signSession = (
  session: Session
): string =>
  jwt.sign(
    session,
    env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );

/**
 * Store the authenticated session in an HTTP-only cookie.
 */
export function setSessionCookie(
  res: Response,
  session: Session
) {
  const isProduction =
    env.NODE_ENV === "production";

  res.cookie(
    env.COOKIE_NAME,
    signSession(session),
    {
      httpOnly: true,

      secure: isProduction,

      sameSite: isProduction
        ? "none"
        : "lax",

      maxAge:
        7 *
        24 *
        60 *
        60 *
        1000,

      path: "/",
    }
  );
}
