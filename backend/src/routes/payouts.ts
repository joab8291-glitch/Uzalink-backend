import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const payoutRouter = Router();

function accepted(res: any) {
  return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

payoutRouter.post("/mpesa/result", async (req, res, next) => {
  try {
    accepted(res);

    const result = req.body?.Result;
    const conversationId = String(result?.ConversationID || "").trim();
    if (!conversationId) return;

    const payout = await prisma.payout.findFirst({
      where: { reference: conversationId },
    });

    if (!payout || payout.status !== "PROCESSING") return;

    if (Number(result?.ResultCode) === 0) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.payout.updateMany({
          where: { id: payout.id, status: "PROCESSING" },
          data: {
            status: "PAID",
            processedAt: new Date(),
            reference: String(result?.TransactionID || conversationId),
          },
        });

        if (claimed.count !== 1) return;

        const released = await tx.sellerProfile.updateMany({
          where: {
            id: payout.sellerId,
            pendingCents: { gte: payout.amountCents },
          },
          data: {
            pendingCents: { decrement: payout.amountCents },
          },
        });

        if (released.count !== 1) {
          throw new Error("Seller pending balance is inconsistent for payout");
        }
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({
        where: { id: payout.id, status: "PROCESSING" },
        data: { status: "FAILED" },
      });

      if (claimed.count !== 1) return;

      const restored = await tx.sellerProfile.updateMany({
        where: {
          id: payout.sellerId,
          pendingCents: { gte: payout.amountCents },
        },
        data: {
          pendingCents: { decrement: payout.amountCents },
          balanceCents: { increment: payout.amountCents },
        },
      });

      if (restored.count !== 1) {
        throw new Error("Seller balance is inconsistent for failed payout");
      }
    });
  } catch (e) {
    next(e);
  }
});

payoutRouter.post("/mpesa/timeout", async (req, res, next) => {
  try {
    accepted(res);

    const conversationId = String(
      req.body?.Result?.ConversationID || ""
    ).trim();

    if (!conversationId) return;

    const payout = await prisma.payout.findFirst({
      where: { reference: conversationId },
    });

    if (!payout || payout.status !== "PROCESSING") return;

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({
        where: { id: payout.id, status: "PROCESSING" },
        data: { status: "FAILED" },
      });

      if (claimed.count !== 1) return;

      const restored = await tx.sellerProfile.updateMany({
        where: {
          id: payout.sellerId,
          pendingCents: { gte: payout.amountCents },
        },
        data: {
          pendingCents: { decrement: payout.amountCents },
          balanceCents: { increment: payout.amountCents },
        },
      });

      if (restored.count !== 1) {
        throw new Error("Seller balance is inconsistent for timed-out payout");
      }
    });
  } catch (e) {
    next(e);
  }
});
