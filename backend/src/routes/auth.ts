import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  hashToken,
  randomToken,
  setSessionCookie,
} from "../lib/auth.js";
import { env } from "../lib/config.js";
import {
  sendEmail,
} from "../services/notifications.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter =
  Router();

const identity = z
  .object({
    email: z
      .string()
      .email()
      .optional(),

    phone: z
      .string()
      .optional(),

    name: z
      .string()
      .min(2)
      .optional(),
  })
  .refine(
    (value) =>
      Boolean(value.email) ||
      Boolean(value.phone),
    {
      message:
        "Email or phone is required",
    }
  );

/**
 * Request Magic Link
 *
 * intent:
 * - buyer
 * - seller
 *
 * SELLER DOES NOT REQUIRE PREMIUM.
 */
authRouter.post(
  "/magic-link",
  async (req, res, next) => {
    try {
      const body =
        identity.parse(req.body);

      const intent =
        req.body?.intent === "seller"
          ? "seller"
          : "buyer";

      let user =
        await prisma.user.findFirst({
          where: body.email
            ? {
                email: body.email,
              }
            : {
                phone: body.phone,
              },
        });

      if (!user) {
        user =
          await prisma.user.create({
            data: {
              email: body.email,
              phone: body.phone,
              name:
                body.name ||
                "UzaLink user",

              role:
                intent === "seller"
                  ? "SELLER"
                  : "BUYER",
            },
          });
      } else if (
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

      const rawToken =
        randomToken();

      await prisma.magicLink.create({
        data: {
          userId: user.id,

          tokenHash:
            hashToken(rawToken),

          expiresAt: new Date(
            Date.now() +
              15 * 60 * 1000
          ),
        },
      });

      const loginPath =
        intent === "seller"
          ? "/#/seller-login"
          : "/#/login";

      const url =
        `${env.FRONTEND_URL}` +
        `${loginPath}` +
        `?token=${rawToken}`;

      if (user.email) {
        await sendEmail(
          user.id,
          user.email,
          "Your UzaLink secure login link",

          `Use this one-time link to sign in to UzaLink:

${url}

This link expires in 15 minutes.`
        );
      }

      res.json({
        ok: true,

        accountType:
          intent === "seller"
            ? "FREE_SELLER"
            : "BUYER",

        message:
          "If the account exists, a secure login link has been sent.",

        ...(env.NODE_ENV !==
        "production"
          ? {
              devLink: url,
            }
          : {}),
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Verify Magic Link
 */
authRouter.post(
  "/verify-magic-link",
  async (req, res, next) => {
    try {
      const token =
        z.string().min(20).parse(
          req.body.token
        );

      const link =
        await prisma.magicLink.findUnique({
          where: {
            tokenHash:
              hashToken(token),
          },

          include: {
            user: true,
          },
        });

      if (
        !link ||
        link.usedAt ||
        link.expiresAt.getTime() <
          Date.now()
      ) {
        return res.status(400).json({
          error:
            "Invalid or expired login link",
        });
      }

      await prisma.magicLink.update({
        where: {
          id: link.id,
        },

        data: {
          usedAt: new Date(),
        },
      });

      const role =
        link.user.role;

      setSessionCookie(res, {
        userId: link.user.id,
        role,
      });

      res.json({
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
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Current authenticated user
 */
authRouter.get(
  "/me",
  requireAuth,
  async (req, res, next) => {
    try {
      const user =
        await prisma.user.findUnique({
          where: {
            id: req.user!.userId,
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

      if (!user) {
        return res.status(401).json({
          error:
            "User not found",
        });
      }

      const premium =
        user.subscriptions.length > 0;

      res.json({
        user,

        seller:
          user.role === "SELLER" ||
          user.role === "ADMIN",

        premium,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Logout
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

    res.json({
      ok: true,
    });
  }
);
