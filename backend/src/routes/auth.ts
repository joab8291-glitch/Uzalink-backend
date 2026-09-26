import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  hashToken,
  randomToken,
  setSessionCookie,
} from "../lib/auth.js";
import { env } from "../lib/config.js";
import { sendEmail } from "../services/notifications.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

/**
 * ---------------------------------------------------------
 * Validation
 * ---------------------------------------------------------
 */

const identity = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .optional(),

    phone: z
      .string()
      .trim()
      .min(7)
      .optional(),

    name: z
      .string()
      .trim()
      .min(2)
      .optional(),
  })
  .refine(
    (value) =>
      Boolean(value.email) ||
      Boolean(value.phone),
    {
      message: "Email or phone is required",
    }
  );

/**
 * ---------------------------------------------------------
 * Request Magic Link
 * ---------------------------------------------------------
 *
 * Supported intents:
 *
 * buyer
 * seller
 *
 * Sellers do NOT require premium.
 */
authRouter.post(
  "/magic-link",
  async (req, res, next) => {
    try {
      const body = identity.parse(req.body);

      const intent =
        req.body?.intent === "seller"
          ? "seller"
          : "buyer";

      const email = body.email
        ? body.email.toLowerCase()
        : undefined;

      const phone = body.phone
        ? body.phone.trim()
        : undefined;

      /**
       * Find an existing account.
       *
       * We first search by email or phone depending
       * on what the user supplied.
       */
      let user = null;

      if (email) {
        user = await prisma.user.findUnique({
          where: {
            email,
          },
        });
      }

      /**
       * If the email did not find an account,
       * try the phone number.
       */
      if (!user && phone) {
        user = await prisma.user.findUnique({
          where: {
            phone,
          },
        });
      }

      /**
       * ---------------------------------------------------
       * Create user if it doesn't exist
       * ---------------------------------------------------
       */
      if (!user) {
        try {
          user = await prisma.user.create({
            data: {
              email,
              phone,
              name:
                body.name ||
                "UzaLink user",

              role:
                intent === "seller"
                  ? "SELLER"
                  : "BUYER",
            },
          });
        } catch (error: any) {
          /**
           * Handle race-condition / duplicate
           * email or phone gracefully.
           *
           * Prisma P2002 = unique constraint violation.
           */
          if (error?.code === "P2002") {
            user = null;

            if (email) {
              user =
                await prisma.user.findUnique({
                  where: {
                    email,
                  },
                });
            }

            if (!user && phone) {
              user =
                await prisma.user.findUnique({
                  where: {
                    phone,
                  },
                });
            }

            if (!user) {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      /**
       * ---------------------------------------------------
       * Promote the configured administrator account.
       * This is an allowlisted account, not a public role
       * selection, so normal users cannot self-promote.
       * ---------------------------------------------------
       */
      if (
        env.ADMIN_EMAIL &&
        user.email &&
        user.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()
      ) {
        if (user.role !== "ADMIN") {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { role: "ADMIN" },
          });
        }
      }

      /**
       * ---------------------------------------------------
       * Promote buyer to seller when seller login
       * is requested.
       * ---------------------------------------------------
       *
       * ADMIN is never downgraded.
       */
      if (
        intent === "seller" &&
        user.role === "BUYER"
      ) {
        user =
          await prisma.user.update({
            where: {
              id: user.id,
            },

            data: {
              role: "SELLER",
            },
          });
      }

      /**
       * ---------------------------------------------------
       * Remove previous unused magic links
       * ---------------------------------------------------
       *
       * This prevents a user from having many valid
       * login links at the same time.
       */
      await prisma.magicLink.deleteMany({
        where: {
          userId: user.id,
          usedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
      });

      /**
       * ---------------------------------------------------
       * Generate secure one-time token
       * ---------------------------------------------------
       */
      const rawToken = randomToken();

      const tokenHash = hashToken(rawToken);

      await prisma.magicLink.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(
            Date.now() +
              15 * 60 * 1000
          ),
        },
      });

      /**
       * ---------------------------------------------------
       * IMPORTANT:
       *
       * Because the frontend uses HashRouter,
       * the token MUST be placed inside the hash.
       *
       * Example:
       *
       * https://uzalink.vercel.app/#/seller-login?token=abc
       *
       * The frontend should read:
       *
       * window.location.hash
       * ---------------------------------------------------
       */
      const loginPath =
        intent === "seller"
          ? "/#/seller-login"
          : "/#/login";

      const separator =
        loginPath.includes("?")
          ? "&"
          : "?";

      const url =
        `${env.FRONTEND_URL}` +
        `${loginPath}` +
        `${separator}token=${encodeURIComponent(
          rawToken
        )}`;

      /**
       * ---------------------------------------------------
       * Send email
       * ---------------------------------------------------
       */
      if (user.email) {
        await sendEmail(
          user.id,
          user.email,
          "Your UzaLink secure login link",

          `Hello ${user.name || "there"},

Use the secure link below to sign in to UzaLink:

${url}

This link is valid for 15 minutes and can only be used once.

If you did not request this login link, you can safely ignore this email.

UzaLink`
        );
      }

      /**
       * ---------------------------------------------------
       * Response
       * ---------------------------------------------------
       */
      return res.status(200).json({
        ok: true,

        accountType:
          intent === "seller"
            ? "FREE_SELLER"
            : "BUYER",

        message:
          "If the account exists, a secure login link has been sent.",

        /**
         * Useful during development.
         * Never expose this in production.
         */
        ...(env.NODE_ENV !== "production"
          ? {
              devLink: url,
            }
          : {}),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * ---------------------------------------------------------
 * Verify Magic Link
 * ---------------------------------------------------------
 *
 * The frontend calls this endpoint after the user
 * clicks the email link.
 */
authRouter.post(
  "/verify-magic-link",
  async (req, res, next) => {
    try {
      const token = z
        .string()
        .trim()
        .min(20)
        .parse(req.body?.token);

      const tokenHash = hashToken(token);

      const link =
        await prisma.magicLink.findUnique({
          where: {
            tokenHash,
          },

          include: {
            user: true,
          },
        });

      /**
       * Token doesn't exist.
       */
      if (!link) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid or expired login link",
        });
      }

      /**
       * Token already used.
       */
      if (link.usedAt) {
        return res.status(400).json({
          ok: false,
          error:
            "This login link has already been used",
        });
      }

      /**
       * Token expired.
       */
      if (
        link.expiresAt.getTime() <
        Date.now()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "This login link has expired",
        });
      }

      /**
       * ---------------------------------------------------
       * Mark token as used BEFORE creating session.
       *
       * This prevents the same token from being reused.
       * ---------------------------------------------------
       */
      await prisma.magicLink.update({
        where: {
          id: link.id,
        },

        data: {
          usedAt: new Date(),
        },
      });

      const role = link.user.role;

      /**
       * ---------------------------------------------------
       * Create authenticated session
       * ---------------------------------------------------
       */
      setSessionCookie(res, {
        userId: link.user.id,
        role,
      });

      /**
       * ---------------------------------------------------
       * Return authenticated user
       * ---------------------------------------------------
       */
      return res.status(200).json({
        ok: true,

        user: {
          id: link.user.id,
          email: link.user.email,
          phone: link.user.phone,
          name: link.user.name,
          role,
        },

        seller:
          role === "SELLER" ||
          role === "ADMIN",

        premium: false,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * ---------------------------------------------------------
 * Current authenticated user
 * ---------------------------------------------------------
 */
authRouter.get(
  "/me",
  requireAuth,
  async (req, res, next) => {
    try {
      if (!req.user?.userId) {
        return res.status(401).json({
          ok: false,
          error:
            "Authentication required",
        });
      }

      const user =
        await prisma.user.findUnique({
          where: {
            id: req.user.userId,
          },

          include: {
            seller: true,

            subscriptions: {
              where: {
                status: "ACTIVE",

                endsAt: {
                  gt: new Date(),
                },
              },

              orderBy: {
                endsAt: "desc",
              },

              take: 1,
            },
          },
        });

      /**
       * Session exists but user no longer exists.
       */
      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "User not found",
        });
      }

      const premium =
        user.subscriptions.length > 0;

      return res.status(200).json({
        ok: true,

        user,

        seller:
          user.role === "SELLER" ||
          user.role === "ADMIN",

        premium,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * ---------------------------------------------------------
 * Logout
 * ---------------------------------------------------------
 */
authRouter.post(
  "/logout",
  (_req, res) => {
    res.clearCookie(
      env.COOKIE_NAME,
      {
        path: "/",
      }
    );

    return res.status(200).json({
      ok: true,
      message: "Logged out successfully",
    });
  }
);
