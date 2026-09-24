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
        await prisma.sellerProfile.findUnique({
          where: {
            userId: req.user!.userId,
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

      if (!seller) {
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
                  sellerId: seller.id,
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
        seller,
        orders,
        premium: Boolean(activeSubscription),
        subscription: activeSubscription,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Create/update seller profile
 *
 * This is available to FREE sellers.
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

          paymentNumber: z.string(),
        })
        .parse(req.body);

      const phone = normalizePhone(
        body.paymentNumber
      );

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
        handleOwner.userId !== req.user!.userId
      ) {
        return res.status(409).json({
          error: "Seller handle is already taken",
        });
      }

      const seller = existing
        ? await prisma.sellerProfile.update({
            where: {
              id: existing.id,
            },
            data: {
              handle: body.handle,
              paymentNumber: phone,
            },
          })
        : await prisma.sellerProfile.create({
            data: {
              userId: req.user!.userId,
              handle: body.handle,
              paymentNumber: phone,
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
          error: "Seller profile not found",
        });
      }

      res.json({
        balanceCents: seller.balanceCents,
        pendingCents: seller.pendingCents,
        lifetimeSalesCents:
          seller.lifetimeSalesCents,
        totalOrders: seller.totalOrders,

        balanceKes:
          seller.balanceCents / 100,

        pendingKes:
          seller.pendingCents / 100,

        lifetimeSalesKes:
          seller.lifetimeSalesCents / 100,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Seller payout
 *
 * FREE sellers can withdraw their available balance.
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
          error: "Seller profile not found",
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
                sellerId: seller.id,
                amountCents:
                  body.amountCents,
                phone:
                  seller.paymentNumber,
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
