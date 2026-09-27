import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { normalizePhone } from "../services/mpesa.js";
import { sendSellerPayout } from "../services/payouts.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole("ADMIN"));

async function ensureActiveSellerProfiles() {
  const sellerUsers = await prisma.user.findMany({
    where: { role: "SELLER" },
    select: { id: true, name: true },
  });

  for (const user of sellerUsers) {
    const existing = await prisma.sellerProfile.findUnique({
      where: { userId: user.id },
    });

    if (existing) continue;

    const base =
      (user.name || "seller")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 18) || "seller";

    let handle = `${base}_${user.id.slice(-6).toLowerCase()}`;
    let suffix = 1;

    while (await prisma.sellerProfile.findUnique({ where: { handle } })) {
      handle = `${base}_${user.id.slice(-6).toLowerCase()}_${suffix++}`;
    }

    await prisma.sellerProfile.create({
      data: { userId: user.id, handle },
    });
  }

  return prisma.sellerProfile.findMany({
    where: { user: { role: "SELLER" } },
    include: {
      user: true,
      products: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      },
      payouts: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}





adminRouter.get("/fulfillment", async (_req, res, next) => {
  try {
    const [deliveries, bookings] = await Promise.all([
      prisma.delivery.findMany({ include: { order: true, product: true }, orderBy: { updatedAt: "desc" }, take: 200 }),
      prisma.booking.findMany({ include: { order: true, product: true }, orderBy: { updatedAt: "desc" }, take: 200 }),
    ]);
    res.json({ deliveries, bookings });
  } catch (e) { next(e); }
});

adminRouter.patch("/deliveries/:id", async (req, res, next) => {
  try {
    const allowed = ["PENDING","PROCESSING","SHIPPED","DELIVERED","CANCELLED"];
    const status = String(req.body?.status || "");
    if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid delivery status" });
    const delivery = await prisma.delivery.update({ where: { id: req.params.id }, data: { status: status as any, trackingCode: req.body?.trackingCode ? String(req.body.trackingCode).slice(0,100) : undefined, notes: req.body?.notes ? String(req.body.notes).slice(0,1000) : undefined } });
    res.json({ delivery });
  } catch (e) { next(e); }
});

adminRouter.patch("/bookings/:id", async (req, res, next) => {
  try {
    const allowed = ["PENDING","CONFIRMED","COMPLETED","CANCELLED"];
    const status = String(req.body?.status || "");
    if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid booking status" });
    const booking = await prisma.booking.update({ where: { id: req.params.id }, data: { status: status as any, notes: req.body?.notes ? String(req.body.notes).slice(0,1000) : undefined, startsAt: req.body?.startsAt ? new Date(req.body.startsAt) : undefined, endsAt: req.body?.endsAt ? new Date(req.body.endsAt) : undefined } });
    res.json({ booking });
  } catch (e) { next(e); }
});

adminRouter.get("/affiliates", async (_req, res, next) => {
  try {
    const commissions = await prisma.affiliateCommission.findMany({
      include: { affiliate: { select: { id: true, name: true, email: true } }, order: { select: { publicId: true, amountCents: true, status: true } } },
      orderBy: { createdAt: "desc" }, take: 200,
    });
    res.json({ commissions });
  } catch (e) { next(e); }
});

adminRouter.post("/affiliates/:id/pay", async (req, res, next) => {
  try {
    const row = await prisma.affiliateCommission.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Affiliate commission not found" });
    if (row.status === "PAID") return res.status(409).json({ error: "Commission already paid" });
    const updated = await prisma.affiliateCommission.update({ where: { id: row.id }, data: { status: "PAID", paidAt: new Date() } });
    res.json({ commission: updated });
  } catch (e) { next(e); }
});

adminRouter.get("/refunds", async (_req, res, next) => {
  try {
    const refunds = await prisma.refund.findMany({ include: { order: { include: { buyer: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
    res.json({ refunds });
  } catch (e) { next(e); }
});

adminRouter.post("/orders/:id/refund", async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!["PAID", "FULFILLED"].includes(order.status)) return res.status(409).json({ error: "Only paid orders can be refunded" });
    const amountCents = Number(req.body?.amountCents ?? order.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > order.amountCents) return res.status(400).json({ error: "Invalid refund amount" });
    const refund = await prisma.$transaction(async tx => {
      const alreadyRefunded = await tx.refund.aggregate({
        where: { orderId: order.id, status: { in: ["APPROVED", "PROCESSING", "REFUNDED"] } },
        _sum: { amountCents: true },
      });
      const refundedCents = alreadyRefunded._sum.amountCents || 0;
      if (refundedCents + amountCents > order.amountCents) {
        throw new Error("Refund amount exceeds the remaining refundable balance");
      }
      const row = await tx.refund.create({ data: { orderId: order.id, amountCents, reason: String(req.body?.reason || "Customer refund request"), status: "APPROVED", adminNote: req.body?.adminNote ? String(req.body.adminNote).slice(0,500) : null } });
      if (refundedCents + amountCents === order.amountCents) {
        await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
      }
      return row;
    });
    res.status(201).json({ refund });
  } catch (e) { next(e); }
});

adminRouter.get("/fraud-flags", async (_req, res, next) => {
  try {
    const flags = await prisma.fraudFlag.findMany({ include: { order: true, user: { select: { id: true, name: true, email: true, phone: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
    res.json({ flags });
  } catch (e) { next(e); }
});

adminRouter.patch("/fraud-flags/:id", async (req, res, next) => {
  try {
    const status = String(req.body?.status || "");
    if (!["OPEN", "REVIEWED", "CLEARED", "BLOCKED"].includes(status)) return res.status(400).json({ error: "Invalid fraud status" });
    const flag = await prisma.fraudFlag.update({ where: { id: req.params.id }, data: { status: status as any, reviewedAt: new Date() } });
    res.json({ flag });
  } catch (e) { next(e); }
});
adminRouter.get("/notifications", async (_req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    res.json({ notifications });
  } catch (e) { next(e); }
});

adminRouter.get("/audit-logs", async (_req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({ include: { user: { select: { id: true, name: true, email: true, role: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
    res.json({ logs });
  } catch (e) { next(e); }
});
adminRouter.get("/dashboard", async (_req, res, next) => {
  try {
    const legacyProfiles = await prisma.sellerProfile.findMany({
      where: { user: { role: { not: "SELLER" } } },
      select: { id: true },
    });

    if (legacyProfiles.length) {
      await prisma.product.updateMany({
        where: {
          sellerId: { in: legacyProfiles.map((profile) => profile.id) },
          status: "ACTIVE",
        },
        data: { status: "DRAFT" },
      });
    }

    const sellerRows = await ensureActiveSellerProfiles();

    const [
      users,
      products,
      orders,
      payouts,
      revenue,
      userRows,
      productRows,
      payoutRows,
      orderRows,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.product.count({
        where: {
          status: "ACTIVE",
          kind: "DIGITAL",
          seller: { user: { role: "SELLER" } },
        },
      }),
      prisma.order.count(),
      prisma.payout.count(),
      prisma.order.aggregate({
        where: { status: { in: ["PAID", "FULFILLED"] } },
        _sum: {
          amountCents: true,
          commissionCents: true,
          sellerNetCents: true,
        },
      }),
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.product.findMany({
        where: {
          status: "ACTIVE",
          kind: "DIGITAL",
          seller: { user: { role: "SELLER" } },
        },
        include: {
          seller: { include: { user: true } },
        },
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
          items: {
            include: {
              product: {
                include: {
                  seller: { include: { user: true } },
                },
              },
            },
          },
          payments: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);

    res.json({
      stats: {
        users,
        sellers: sellerRows.length,
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


adminRouter.patch("/products/:id/featured", async (req, res, next) => {
  try {
    const featured = Boolean(req.body?.featured);
    const product = await prisma.product.update({ where: { id: req.params.id }, data: { featured } });
    res.json({ product });
  } catch (e) { next(e); }
});

adminRouter.patch("/sellers/:id/featured", async (req, res, next) => {
  try {
    const featured = Boolean(req.body?.featured);
    const seller = await prisma.sellerProfile.update({ where: { id: req.params.id }, data: { featured } });
    res.json({ seller });
  } catch (e) { next(e); }
});

adminRouter.patch("/sellers/:id/verification", async (req, res, next) => {
  try {
    const verified = Boolean(req.body?.verified);
    const seller = await prisma.sellerProfile.update({
      where: { id: req.params.id },
      data: { verifiedAt: verified ? new Date() : null, verificationNote: req.body?.note ? String(req.body.note).slice(0, 500) : null },
    });
    res.json({ seller });
  } catch (e) { next(e); }
});

adminRouter.get("/reviews", async (_req, res, next) => {
  try {
    const reviews = await prisma.review.findMany({
      include: { user: { select: { id: true, name: true, email: true } }, product: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: "desc" }, take: 200,
    });
    res.json({ reviews });
  } catch (e) { next(e); }
});

adminRouter.patch("/reviews/:id", async (req, res, next) => {
  try {
    const review = await prisma.review.update({ where: { id: req.params.id }, data: { approved: Boolean(req.body?.approved) } });
    const aggregate = await prisma.review.aggregate({ where: { productId: review.productId, approved: true }, _avg: { rating: true } });
    await prisma.product.update({ where: { id: review.productId }, data: { rating: aggregate._avg.rating ?? 0 } });
    res.json({ review });
  } catch (e) { next(e); }
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

    if (payout.seller.user.role !== "SELLER") {
      return res.status(403).json({
        error: "This payout belongs to an inactive seller account.",
      });
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

    if (seller.user.role !== "SELLER") {
      return res.status(403).json({
        error: "Only active SELLER accounts can receive author payouts.",
      });
    }

    if (!seller.paymentNumber) {
      return res.status(400).json({
        error: "This author has not configured a payout phone number.",
      });
    }

    const phone = normalizePhone(seller.paymentNumber);

    const payout = await prisma.$transaction(async (tx) => {
      const reserved = await tx.sellerProfile.updateMany({
        where: { id: seller.id, balanceCents: { gte: amountCents } },
        data: {
          balanceCents: { decrement: amountCents },
          pendingCents: { increment: amountCents },
        },
      });

      if (reserved.count !== 1) {
        throw new Error("The author's available balance has changed. Refresh and try again.");
      }

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
    if (payout.status === "FAILED") return res.status(409).json({ error: "Failed payouts must be re-created so the seller balance can be reserved again." });

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({
        where: { id: payout.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: {
          status: "PAID",
          processedAt: new Date(),
          reference: req.body?.reference || payout.reference,
        },
      });
      if (claimed.count !== 1) throw new Error("Payout has already been settled");
      const row = await tx.payout.findUniqueOrThrow({ where: { id: payout.id } });
      const seller = await tx.sellerProfile.updateMany({
        where: { id: payout.sellerId, pendingCents: { gte: payout.amountCents } },
        data: { pendingCents: { decrement: payout.amountCents } },
      });
      if (seller.count !== 1) throw new Error("Seller pending balance is inconsistent");
      return row;
    });

    res.json({ payout: updated });
  } catch (e) {
    next(e);
  }
});
