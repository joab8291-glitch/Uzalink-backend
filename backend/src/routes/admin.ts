import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole("ADMIN"));

adminRouter.get("/dashboard", async (_req, res, next) => {
  try {
    const [users, sellers, products, orders, payouts, revenue, userRows, sellerRows, productRows, payoutRows, orderRows] =
      await Promise.all([
        prisma.user.count(),
        prisma.sellerProfile.count(),
        prisma.product.count(),
        prisma.order.count(),
        prisma.payout.count(),
        prisma.order.aggregate({
          where: { status: { in: ["PAID", "FULFILLED"] } },
          _sum: { amountCents: true, commissionCents: true, sellerNetCents: true },
        }),
        prisma.user.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
        prisma.sellerProfile.findMany({
          include: { user: true, products: true, payouts: { orderBy: { createdAt: "desc" }, take: 20 } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        prisma.product.findMany({
          include: { seller: { include: { user: true } } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        prisma.payout.findMany({
          include: { seller: { include: { user: true } } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        prisma.order.findMany({
          include: {
            buyer: true,
            items: { include: { product: { include: { seller: { include: { user: true } } } } } },
            payments: true,
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      ]);

    res.json({
      stats: {
        users,
        sellers,
        products,
        orders,
        payouts,
        grossCents: revenue._sum.amountCents || 0,
        commissionCents: revenue._sum.commissionCents || 0,
        sellerNetCents: revenue._sum.sellerNetCents || 0,
      },
      users: userRows,
      sellers: sellerRows,
      products: productRows,
      payouts: payoutRows,
      orders: orderRows,
    });
  } catch (e) {
    next(e);
  }
});

adminRouter.get("/orders", async (_req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        buyer: true,
        items: { include: { product: { include: { seller: { include: { user: true } } } } } },
        payments: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ orders });
  } catch (e) {
    next(e);
  }
});

adminRouter.post("/products/:id/status", async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const product = await prisma.product.update({ where: { id: req.params.id }, data: { status } });
    res.json({ product });
  } catch (e) {
    next(e);
  }
});

adminRouter.post("/payouts/:id/mark-paid", async (req, res, next) => {
  try {
    const payout = await prisma.payout.findUnique({ where: { id: req.params.id } });
    if (!payout) return res.status(404).json({ error: "Payout not found" });
    if (payout.status === "PAID") return res.json({ payout });

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.payout.update({
        where: { id: payout.id },
        data: {
          status: "PAID",
          processedAt: new Date(),
          reference: req.body?.reference || payout.reference,
        },
      });
      await tx.sellerProfile.update({
        where: { id: payout.sellerId },
        data: { pendingCents: { decrement: payout.amountCents } },
      });
      return row;
    });

    res.json({ payout: updated });
  } catch (e) {
    next(e);
  }
});
