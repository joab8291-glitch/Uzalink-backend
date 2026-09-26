import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { normalizePhone } from "../services/mpesa.js";
import { sendSellerPayout } from "../services/payouts.js";

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


adminRouter.post("/payouts/:id/send-mpesa", async (req, res, next) => {
  try {
    const payout = await prisma.payout.findUnique({
      where: { id: req.params.id },
      include: { seller: { include: { user: true } } },
    });

    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (payout.status === "PAID") {
      return res.status(409).json({ error: "This payout has already been paid." });
    }

    if (payout.status === "PROCESSING") {
      return res.status(409).json({
        error: "This payout is already being processed by M-Pesa.",
      });
    }

    if (!payout.phone) {
      return res.status(400).json({
        error: "This author does not have a payout phone number.",
      });
    }

    const phone = normalizePhone(payout.phone);

    await prisma.payout.update({
      where: { id: payout.id },
      data: { phone },
    });

    try {
      const mpesa = await sendSellerPayout(payout.id);
      return res.json({ payoutId: payout.id, mpesa });
    } catch (error) {
      await prisma.payout.update({
        where: { id: payout.id },
        data: { status: "FAILED" },
      });

      return next(error);
    }
  } catch (e) {
    next(e);
  }
});

adminRouter.post("/payouts", async (req, res, next) => {
  try {
    const sellerId = String(req.body?.sellerId || "");
    const amountCents = Number(req.body?.amountCents);

    if (!sellerId || !Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({
        error: "sellerId and a positive whole-number amountCents are required.",
      });
    }

    const seller = await prisma.sellerProfile.findUnique({
      where: { id: sellerId },
      include: { user: true },
    });

    if (!seller) {
      return res.status(404).json({ error: "Author/seller not found." });
    }

    if (!seller.paymentNumber) {
      return res.status(400).json({
        error: "This author has not configured a payout phone number.",
      });
    }

    if (amountCents > seller.balanceCents) {
      return res.status(400).json({
        error: "The payout exceeds the author's available balance.",
      });
    }

    const phone = normalizePhone(seller.paymentNumber);

    const payout = await prisma.$transaction(async (tx) => {
      await tx.sellerProfile.update({
        where: { id: seller.id },
        data: {
          balanceCents: { decrement: amountCents },
          pendingCents: { increment: amountCents },
        },
      });

      return tx.payout.create({
        data: {
          sellerId: seller.id,
          amountCents,
          phone,
          status: "PENDING",
        },
        include: {
          seller: { include: { user: true } },
        },
      });
    });

    try {
      const mpesa = await sendSellerPayout(payout.id);
      return res.status(201).json({ payout, mpesa });
    } catch (error) {
      await prisma.$transaction([
        prisma.payout.update({
          where: { id: payout.id },
          data: { status: "FAILED" },
        }),
        prisma.sellerProfile.update({
          where: { id: seller.id },
          data: {
            pendingCents: { decrement: amountCents },
            balanceCents: { increment: amountCents },
          },
        }),
      ]);

      return next(error);
    }
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
