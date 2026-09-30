import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const payoutRouter = Router();

function accepted(res: any) {
  return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

async function findPayoutFromResult(result: any) {
  const conversationId = String(result?.ConversationID || "").trim();
  const originatorConversationId = String(result?.OriginatorConversationID || "").trim();
  if (!conversationId && !originatorConversationId) return null;

  return prisma.payout.findFirst({
    where: {
      OR: [
        ...(conversationId ? [{ reference: conversationId }] : []),
        ...(originatorConversationId ? [{ reference: originatorConversationId }] : []),
      ],
    },
  });
}

payoutRouter.post("/mpesa/result", async (req, res, next) => {
  try {
    accepted(res);

    const result = req.body?.Result;
    const payout = await findPayoutFromResult(result);
    if (!payout || payout.status !== "PROCESSING") return;

    if (Number(result?.ResultCode) === 0) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.payout.updateMany({
          where: { id: payout.id, status: "PROCESSING" },
          data: {
            status: "PAID",
            processedAt: new Date(),
            reference: String(result?.TransactionID || result?.ConversationID || payout.reference || ""),
          },
        });

        if (claimed.count !== 1) return;

        const released = await tx.sellerProfile.updateMany({
          where: { id: payout.sellerId, pendingCents: { gte: payout.amountCents } },
          data: { pendingCents: { decrement: payout.amountCents } },
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
        where: { id: payout.sellerId, pendingCents: { gte: payout.amountCents } },
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

    const payout = await findPayoutFromResult(req.body?.Result);
    if (!payout || payout.status !== "PROCESSING") return;

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({
        where: { id: payout.id, status: "PROCESSING" },
        data: { status: "FAILED" },
      });
      if (claimed.count !== 1) return;

      const restored = await tx.sellerProfile.updateMany({
        where: { id: payout.sellerId, pendingCents: { gte: payout.amountCents } },
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
