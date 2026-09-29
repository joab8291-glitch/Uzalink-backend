import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashToken, randomToken, setSessionCookie } from "../lib/auth.js";
import { env } from "../lib/config.js";
import { sendEmail } from "../services/notifications.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

const identity = z.object({
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(7).optional(),
  name: z.string().trim().min(2).optional(),
}).refine((value) => Boolean(value.email) || Boolean(value.phone), {
  message: "Email or phone is required",
});

function normalizeIdentity(value: string) {
  const trimmed = value.trim();

  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }

  return trimmed.replace(/\D/g, "");
}

async function ensurePremiumSeller(
  userId: string,
  name?: string | null
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error("User not found");
  }

  if (user.role !== "SELLER") {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        role: "SELLER",
      },
    });
  }

  let seller = await prisma.sellerProfile.findUnique({
    where: {
      userId: user.id,
    },
  });

  if (!seller) {
    const base =
      (name || user.name || "seller")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 18) || "seller";

    let handle = `${base}_${user.id.slice(-6).toLowerCase()}`;
    let counter = 1;

    while (
      await prisma.sellerProfile.findUnique({
        where: { handle },
      })
    ) {
      handle = `${base}_${user.id.slice(-6).toLowerCase()}_${counter++}`;
    }

    seller = await prisma.sellerProfile.create({
      data: {
        userId: user.id,
        handle,
      },
    });
  }

  return seller;
}

function isConfiguredAdmin(user: {
  email: string | null;
  phone: string | null;
}) {
  const emailMatches = Boolean(
    env.ADMIN_EMAIL &&
      user.email &&
      user.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()
  );

  const phoneMatches = Boolean(
    env.ADMIN_PHONE &&
      user.phone &&
      user.phone.replace(/\s+/g, "") ===
        env.ADMIN_PHONE.replace(/\s+/g, "")
  );

  return emailMatches || phoneMatches;
}

authRouter.post("/magic-link", async (req, res, next) => {
  try {
    const body = identity.parse(req.body);
    const intent =
      req.body?.intent === "seller" ? "seller" : "buyer";

    const email = body.email
      ? body.email.toLowerCase()
      : undefined;

    const phone = body.phone
      ? body.phone.trim()
      : undefined;

    let user = null;

    if (email) {
      user = await prisma.user.findUnique({
        where: { email },
      });
    }

    if (!user && phone) {
      user = await prisma.user.findUnique({
        where: { phone },
      });
    }

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            email,
            phone,
            name: body.name || "UzaLink user",
            role:
              intent === "seller"
                ? "SELLER"
                : "BUYER",
          },
        });
      } catch (error: any) {
        if (error?.code !== "P2002") {
          throw error;
        }

        user = email
          ? await prisma.user.findUnique({
              where: { email },
            })
          : null;

        if (!user && phone) {
          user = await prisma.user.findUnique({
            where: { phone },
          });
        }

        if (!user) {
          throw error;
        }
      }
    }

    /*
     * Admin access is controlled only by server-side environment
     * variables. Users cannot choose ADMIN from the frontend.
     */
    if (
      isConfiguredAdmin(user) &&
      user.role !== "ADMIN"
    ) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: "ADMIN" },
      });
    }

    if (
      intent === "seller" &&
      user.role === "BUYER"
    ) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: "SELLER" },
      });
    }

    await prisma.magicLink.deleteMany({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    const rawToken = randomToken();

    await prisma.magicLink.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(
          Date.now() + 15 * 60 * 1000
        ),
      },
    });

    const loginPath =
      intent === "seller"
        ? "/#/seller-login"
        : "/#/login";

    const url =
      `${env.FRONTEND_URL}${loginPath}` +
      `?token=${encodeURIComponent(rawToken)}`;

    if (user.email) {
      await sendEmail(
        user.id,
        user.email,
        "Your UzaLink secure login link",
        `Hello ${user.name || "there"},\n\nUse the secure link below to sign in to UzaLink:\n\n${url}\n\nThis link is valid for 15 minutes and can only be used once.\n\nUzaLink`
      );
    }

    return res.status(200).json({
      ok: true,
      accountType:
        intent === "seller"
          ? "FREE_SELLER"
          : "BUYER",
      message:
        "If the account exists, a secure login link has been sent.",
      ...(env.NODE_ENV !== "production"
        ? { devLink: url }
        : {}),
    });
  } catch (error) {
    next(error);
  }
});

/*
 * PREMIUM MAGIC LOGIN
 *
 * TEMPORARY TESTING MODE:
 *
 * When PREMIUM_OPEN_GATE=true:
 * - Any phone number or email may request Premium login.
 * - A Premium seller account is created automatically if needed.
 * - A temporary Premium subscription is created automatically.
 * - The configured PREMIUM_TEST_CODE is used.
 *
 * When PREMIUM_OPEN_GATE=false:
 * - An existing Premium seller account is required.
 * - An active Premium subscription is required.
 * - A normal generated verification code is used.
 */

authRouter.post(
  "/premium/request",
  async (req, res, next) => {
    try {
      const rawIdentity = z
        .string()
        .trim()
        .min(3)
        .parse(req.body?.identity);

      const identityValue =
        normalizeIdentity(rawIdentity);

      const openGate =
        env.PREMIUM_OPEN_GATE;

      let user = null;

      /*
       * Find the existing account first.
       */
      if (identityValue.includes("@")) {
        user = await prisma.user.findUnique({
          where: {
            email: identityValue,
          },
        });
      } else {
        user = await prisma.user.findUnique({
          where: {
            phone: identityValue,
          },
        });
      }

      /*
       * In temporary open-gate mode, automatically create
       * a seller account using the identity supplied by the user.
       */
      if (!user && openGate) {
        const accountData = identityValue.includes("@")
          ? {
              email: identityValue,
              phone: undefined,
              name: "Premium Seller",
              role: "SELLER" as const,
            }
          : {
              email: undefined,
              phone: identityValue,
              name: "Premium Seller",
              role: "SELLER" as const,
            };

        try {
          user = await prisma.user.create({
            data: accountData,
          });
        } catch (error: any) {
          /*
           * Handle a race where another request created
           * the same account at the same time.
           */
          if (error?.code !== "P2002") {
            throw error;
          }

          user = identityValue.includes("@")
            ? await prisma.user.findUnique({
                where: {
                  email: identityValue,
                },
              })
            : await prisma.user.findUnique({
                where: {
                  phone: identityValue,
                },
              });
        }
      }

      /*
       * Outside testing mode, the user must already exist.
       */
      if (!user) {
        return res.status(404).json({
          error:
            "No Premium seller account was found for that phone number or email.",
        });
      }

      /*
       * Make sure the account has a seller profile.
       */
      await ensurePremiumSeller(
        user.id,
        user.name
      );

      /*
       * Temporary open gate automatically grants a
       * temporary Premium subscription for testing.
       */
      if (openGate) {
        const active =
          await prisma.subscription.findFirst({
            where: {
              userId: user.id,
              status: "ACTIVE",
              endsAt: {
                gt: new Date(),
              },
            },
          });

        if (!active) {
          await prisma.subscription.create({
            data: {
              userId: user.id,
              status: "ACTIVE",
              plan: "premium",
              priceCents:
                env.PREMIUM_PRICE_KES * 100,
              startsAt: new Date(),
              endsAt: new Date(
                Date.now() +
                  env.PREMIUM_DURATION_DAYS *
                    24 *
                    60 *
                    60 *
                    1000
              ),
            },
          });
        }
      } else {
        /*
         * Normal production Premium validation.
         */
        const active =
          await prisma.subscription.findFirst({
            where: {
              userId: user.id,
              status: "ACTIVE",
              endsAt: {
                gt: new Date(),
              },
            },
          });

        if (!active) {
          return res.status(403).json({
            error:
              "Premium subscription is required for Premium Magic Login.",
          });
        }
      }

      /*
       * Testing mode always uses the fixed configured code.
       * Production mode generates a random six-digit code.
       */
      const code = openGate
        ? env.PREMIUM_TEST_CODE
        : String(
            Math.floor(
              100000 +
                Math.random() * 900000
            )
          );

      /*
       * Remove previous unused Premium codes.
       */
      await prisma.magicLink.deleteMany({
        where: {
          userId: user.id,
          usedAt: null,
        },
      });

      /*
       * Store a hashed verification value.
       */
      await prisma.magicLink.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(
            `premium:${identityValue}:${code}`
          ),
          expiresAt: new Date(
            Date.now() + 10 * 60 * 1000
          ),
        },
      });

      /*
       * Send the SMS through the configured provider when available.
       *
       * In testing mode, the code remains fixed at the configured
       * PREMIUM_TEST_CODE so the flow can be tested consistently.
       */
      if (
        env.SMS_WEBHOOK_URL &&
        user.phone
      ) {
        try {
          await fetch(
            env.SMS_WEBHOOK_URL,
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json",
                ...(env.SMS_WEBHOOK_TOKEN
                  ? {
                      Authorization:
                        `Bearer ${env.SMS_WEBHOOK_TOKEN}`,
                    }
                  : {}),
              },
              body: JSON.stringify({
                phone: user.phone,
                code,
                message:
                  `Your UzaLink Premium login code is ${code}`,
              }),
            }
          );
        } catch (smsError) {
          /*
           * Do not block the login flow if the external
           * SMS provider is unavailable during testing.
           */
          console.error(
            "[PREMIUM SMS] Failed to send verification code",
            smsError
          );
        }
      }

      return res.json({
        ok: true,
        message:
          "SMS verification code sent.",
        testMode: openGate,
        ...(env.NODE_ENV !== "production" &&
        openGate
          ? {
              devCode:
                env.PREMIUM_TEST_CODE,
            }
          : {}),
      });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  "/premium/verify",
  async (req, res, next) => {
    try {
      const rawIdentity = z
        .string()
        .trim()
        .min(3)
        .parse(req.body?.identity);

      const code = z
        .string()
        .trim()
        .min(4)
        .max(8)
        .parse(req.body?.code);

      const identityValue =
        normalizeIdentity(rawIdentity);

      const expectedToken = hashToken(
        `premium:${identityValue}:${code}`
      );

      const link =
        await prisma.magicLink.findUnique({
          where: {
            tokenHash: expectedToken,
          },
          include: {
            user: true,
          },
        });

      if (!link || link.usedAt) {
        return res.status(400).json({
          error:
            "Invalid or already used Premium verification code.",
        });
      }

      if (
        link.expiresAt.getTime() <
        Date.now()
      ) {
        return res.status(400).json({
          error:
            "Premium verification code has expired.",
        });
      }

      /*
       * In open-gate testing mode, make sure the
       * account has an active temporary Premium subscription.
       */
      let activeSubscription =
        await prisma.subscription.findFirst({
          where: {
            userId: link.user.id,
            status: "ACTIVE",
            endsAt: {
              gt: new Date(),
            },
          },
          orderBy: {
            endsAt: "desc",
          },
        });

      if (
        !activeSubscription &&
        env.PREMIUM_OPEN_GATE
      ) {
        activeSubscription =
          await prisma.subscription.create({
            data: {
              userId: link.user.id,
              status: "ACTIVE",
              plan: "premium",
              priceCents:
                env.PREMIUM_PRICE_KES * 100,
              startsAt: new Date(),
              endsAt: new Date(
                Date.now() +
                  env.PREMIUM_DURATION_DAYS *
                    24 *
                    60 *
                    60 *
                    1000
              ),
            },
          });
      }

      /*
       * Normal Premium authentication still requires
       * an active subscription.
       */
      if (!activeSubscription) {
        return res.status(403).json({
          error:
            "Active Premium subscription required.",
        });
      }

      await ensurePremiumSeller(
        link.user.id,
        link.user.name
      );

      /*
       * Consume the verification code.
       */
      await prisma.magicLink.update({
        where: {
          id: link.id,
        },
        data: {
          usedAt: new Date(),
        },
      });

      /*
       * Create the normal UzaLink authenticated session.
       */
      setSessionCookie(res, {
        userId: link.user.id,
        role: "SELLER",
      });

      const user =
        await prisma.user.findUnique({
          where: {
            id: link.user.id,
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

      return res.json({
        ok: true,
        user,
        seller: true,
        premium: true,
      });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  "/verify-magic-link",
  async (req, res, next) => {
    try {
      const token = z
        .string()
        .trim()
        .min(20)
        .parse(req.body?.token);

      const link =
        await prisma.magicLink.findUnique({
          where: {
            tokenHash: hashToken(token),
          },
          include: {
            user: true,
          },
        });

      if (!link) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid or expired login link",
        });
      }

      if (link.usedAt) {
        return res.status(400).json({
          ok: false,
          error:
            "This login link has already been used",
        });
      }

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

      await prisma.magicLink.update({
        where: {
          id: link.id,
        },
        data: {
          usedAt: new Date(),
        },
      });

      setSessionCookie(res, {
        userId: link.user.id,
        role: link.user.role,
      });

      return res.status(200).json({
        ok: true,
        user: {
          id: link.user.id,
          email: link.user.email,
          phone: link.user.phone,
          name: link.user.name,
          role: link.user.role,
        },
        seller:
          link.user.role === "SELLER" ||
          link.user.role === "ADMIN",
        premium: false,
      });
    } catch (error) {
      next(error);
    }
  }
);

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

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "User not found",
        });
      }

      return res.status(200).json({
        ok: true,
        user,
        seller:
          user.role === "SELLER" ||
          user.role === "ADMIN",
        premium:
          user.subscriptions.length > 0,
      });
    } catch (error) {
      next(error);
    }
  }
);

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
      message:
        "Logged out successfully",
    });
  }
);
