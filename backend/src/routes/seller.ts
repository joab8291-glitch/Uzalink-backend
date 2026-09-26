import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { normalizePhone } from "../services/mpesa.js";
import { sendSellerPayout } from "../services/payouts.js";

export const sellerRouter = Router();

sellerRouter.use(
  requireAuth,
  requireRole("SELLER", "ADMIN")
);

/**
 * Generate a unique temporary seller handle.
 *
 * The seller can later change this from the seller profile.
 */
async function generateSellerHandle(
  userId: string,
  name?: string | null
): Promise<string> {
  const base =
    (name || "seller")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 18) || "seller";

  let handle = `${base}_${userId.slice(-6).toLowerCase()}`;

  let existing =
    await prisma.sellerProfile.findUnique({
      where: { handle },
    });

  let counter = 1;

  while (existing) {
    handle = `${base}_${userId
      .slice(-6)
      .toLowerCase()}_${counter}`;

    existing =
      await prisma.sellerProfile.findUnique({
        where: { handle },
      });

    counter++;
  }

  return handle;
}

/**
 * Make sure every SELLER/ADMIN has a SellerProfile.
 *
 * A seller can exist without a payout number.
 * paymentNumber is therefore allowed to remain null
 * until the seller configures it.
 */
async function ensureSellerProfile(
  userId: string
) {
  const existing =
    await prisma.sellerProfile.findUnique({
      where: { userId },
      include: {
        user: true,
      },
    });

  if (existing) {
    return existing;
  }

  const user =
    await prisma.user.findUnique({
      where: { id: userId },
    });

  if (!user) {
    throw new Error("User not found");
  }

  const handle =
    await generateSellerHandle(
      user.id,
      user.name
    );

  return prisma.sellerProfile.create({
    data: {
      userId: user.id,
      handle,
      paymentNumber: null,
    },
    include: {
      user: true,
    },
  });
}

/**
 * Seller dashboard
 *
 * FREE sellers can access their dashboard.
 * Premium is NOT required to sell.
 */
sellerRouter.get(
  "/dashboard",
  async (req, res, next) => {
    try {
      const seller =
        await ensureSellerProfile(
          req.user!.userId
        );

      const fullSeller =
        await prisma.sellerProfile.findUnique({
          where: {
            id: seller.id,
          },
          include: {
            user: true,

            products: {
              orderBy: {
                createdAt: "desc",
              },
            },

            payouts: {
              orderBy: {
                createdAt: "desc",
              },
              take: 20,
            },
          },
        });

      if (!fullSeller) {
        return res.status(404).json({
          error: "Seller profile not found",
          code: "SELLER_PROFILE_REQUIRED",
        });
      }

      const orders =
        await prisma.order.findMany({
          where: {
            items: {
              some: {
                product: {
                  sellerId: fullSeller.id,
                },
              },
            },
          },

          include: {
            items: {
              include: {
                product: true,
              },
            },

            payments: true,
          },

          orderBy: {
            createdAt: "desc",
          },

          take: 50,
        });

      const activeSubscription =
        await prisma.subscription.findFirst({
          where: {
            userId: req.user!.userId,

            status: "ACTIVE",

            endsAt: {
              gt: new Date(),
            },
          },

          orderBy: {
            endsAt: "desc",
          },
        });

      res.json({
        seller: fullSeller,
        orders,
        premium:
          Boolean(activeSubscription),
        subscription:
          activeSubscription,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Create/update seller profile
 *
 * Available to FREE sellers.
 *
 * paymentNumber is optional while creating
 * the seller profile, but when supplied it is
 * normalized before storage.
 */
sellerRouter.post(
  "/profile",
  async (req, res, next) => {
    try {
      const body = z
        .object({
          handle: z
            .string()
            .min(3)
            .max(30)
            .regex(
              /^[a-z0-9_]+$/,
              "Handle can only contain lowercase letters, numbers and underscores"
            ),

          paymentNumber: z
            .string()
            .optional()
            .or(z.literal("")),
        })
        .parse(req.body);

      const paymentNumber =
        body.paymentNumber
          ? normalizePhone(
              body.paymentNumber
            )
          : null;

      const existing =
        await prisma.sellerProfile.findUnique({
          where: {
            userId: req.user!.userId,
          },
        });

      const handleOwner =
        await prisma.sellerProfile.findUnique({
          where: {
            handle: body.handle,
          },
        });

      if (
        handleOwner &&
        handleOwner.userId !==
          req.user!.userId
      ) {
        return res.status(409).json({
          error:
            "Seller handle is already taken",
        });
      }

      const seller = existing
        ? await prisma.sellerProfile.update({
            where: {
              id: existing.id,
            },

            data: {
              handle: body.handle,
              paymentNumber,
            },
          })
        : await prisma.sellerProfile.create({
            data: {
              userId:
                req.user!.userId,
              handle:
                body.handle,
              paymentNumber,
            },
          });

      res.json({
        seller,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Seller balance
 */
sellerRouter.get(
  "/balance",
  async (req, res, next) => {
    try {
      const seller =
        await prisma.sellerProfile.findUnique({
          where: {
            userId: req.user!.userId,
          },

          select: {
            balanceCents: true,
            pendingCents: true,
            lifetimeSalesCents: true,
            totalOrders: true,
          },
        });

      if (!seller) {
        return res.status(404).json({
          error:
            "Seller profile not found",
        });
      }

      res.json({
        balanceCents:
          seller.balanceCents,

        pendingCents:
          seller.pendingCents,

        lifetimeSalesCents:
          seller.lifetimeSalesCents,

        totalOrders:
          seller.totalOrders,

        balanceKes:
          seller.balanceCents / 100,

        pendingKes:
          seller.pendingCents / 100,

        lifetimeSalesKes:
          seller.lifetimeSalesCents /
          100,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Seller payout
 *
 * FREE sellers can withdraw their
 * available balance.
 */
sellerRouter.post(
  "/payout",
  async (req, res, next) => {
    try {
      const body = z
        .object({
          amountCents: z
            .number()
            .int()
            .positive(),
        })
        .parse(req.body);

      const seller =
        await prisma.sellerProfile.findUnique({
          where: {
            userId: req.user!.userId,
          },
        });

      if (!seller) {
        return res.status(404).json({
          error:
            "Seller profile not found",
        });
      }

      if (!seller.paymentNumber) {
        return res.status(400).json({
          error:
            "Set your payout phone number before requesting a payout",
        });
      }

      if (
        body.amountCents >
        seller.balanceCents
      ) {
        return res.status(400).json({
          error:
            "Insufficient available balance",
        });
      }

      const payout =
        await prisma.$transaction(
          async (tx) => {
            await tx.sellerProfile.update({
              where: {
                id: seller.id,
              },

              data: {
                balanceCents: {
                  decrement:
                    body.amountCents,
                },

                pendingCents: {
                  increment:
                    body.amountCents,
                },
              },
            });

            return tx.payout.create({
              data: {
                sellerId:
                  seller.id,

                amountCents:
                  body.amountCents,

                phone:
                  seller.paymentNumber!,
              },
            });
          }
        );

      let mpesa;

      try {
        mpesa =
          await sendSellerPayout(
            payout.id
          );
      } catch (error) {
        await prisma.$transaction([
          prisma.payout.update({
            where: {
              id: payout.id,
            },

            data: {
              status: "FAILED",
            },
          }),

          prisma.sellerProfile.update({
            where: {
              id: seller.id,
            },

            data: {
              pendingCents: {
                decrement:
                  body.amountCents,
              },

              balanceCents: {
                increment:
                  body.amountCents,
              },
            },
          }),
        ]);

        throw error;
      }

      res.status(201).json({
        payout,
        mpesa,
      });
    } catch (e) {
      next(e);
    }
  }
);
