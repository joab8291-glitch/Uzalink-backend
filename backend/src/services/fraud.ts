import { prisma } from "../lib/prisma.js";

export async function inspectOrderRisk(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payments: true, buyer: true, items: true },
  });
  if (!order) return null;

  const flags: { reason: string; score: number; metadata?: any }[] = [];
  const recent = await prisma.order.count({
    where: {
      buyerPhone: order.buyerPhone,
      createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
    },
  });

  if (recent >= 5) flags.push({ reason: "High order frequency from the same phone", score: 35, metadata: { recentOrders: recent } });
  if (order.amountCents >= 500000) flags.push({ reason: "High-value order requires review", score: 20 });
  if (order.payments.length > 3) flags.push({ reason: "Multiple payment attempts on one order", score: 30 });

  if (!flags.length) return null;

  const score = Math.min(100, flags.reduce((sum, f) => sum + f.score, 0));
  const created = [];
  for (const flag of flags) {
    created.push(await prisma.fraudFlag.create({
      data: { orderId, userId: order.buyerId, reason: flag.reason, score: flag.score, metadata: flag.metadata },
    }));
  }
  return { score, flags: created };
}
