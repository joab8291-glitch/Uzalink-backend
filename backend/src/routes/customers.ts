import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

export const customerRouter = Router();

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return `0${digits.slice(3)}`;
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) return `0${digits}`;
  return digits;
}

customerRouter.post("/from-order", async (req, res, next) => {
  try {
    const body = z.object({
      orderId: z.string().min(1),
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().min(7),
      email: z.string().trim().email().optional(),
    }).parse(req.body);

    const order = await prisma.order.findUnique({
      where: { id: body.orderId },
      select: {
        id: true,
        status: true,
        buyerId: true,
        buyerPhone: true,
        buyerEmail: true,
        buyerName: true,
      },
    });

    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!["PAID", "FULFILLED"].includes(order.status)) {
      return res.status(409).json({ error: "Customer can only be registered after payment is confirmed" });
    }

    if (normalizePhone(order.buyerPhone) !== normalizePhone(body.phone)) {
      return res.status(403).json({ error: "The customer phone number does not match the paid order" });
    }

    if (order.buyerId) {
      const existing = await prisma.user.findUnique({ where: { id: order.buyerId } });
      return res.json({ ok: true, created: false, user: existing });
    }

    const normalizedPhone = normalizePhone(body.phone);
    const normalizedEmail = body.email?.toLowerCase() || order.buyerEmail?.toLowerCase() || undefined;

    let user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
    if (!user && normalizedEmail) {
      user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    }

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            name: body.name,
            phone: normalizedPhone,
            email: normalizedEmail,
            role: "BUYER",
          },
        });
      } catch (error: any) {
        if (error?.code !== "P2002") throw error;
        user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
        if (!user && normalizedEmail) {
          user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        }
        if (!user) throw error;
      }
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { buyerId: user.id },
    });

    return res.json({ ok: true, created: true, user });
  } catch (error) {
    next(error);
  }
});
