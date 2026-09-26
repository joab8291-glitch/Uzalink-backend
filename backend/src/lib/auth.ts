```ts
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env } from "./config.js";

export type Session = {
  userId: string;
  role: "BUYER" | "SELLER" | "ADMIN";
};

export const hashToken = (token: string) =>
  crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

export const randomToken = (bytes = 32) =>
  crypto.randomBytes(bytes).toString("hex");

export const signSession = (session: Session) =>
  jwt.sign(session, env.JWT_SECRET, {
    expiresIn: "7d",
  });

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

      // Required because the frontend and backend
      // are hosted on different sites.
      secure: isProduction,

      // Required for cross-site frontend/API requests.
      sameSite: isProduction
        ? "none"
        : "lax",

      maxAge:
        7 * 24 * 60 * 60 * 1000,

      path: "/",
    }
  );
}
```
