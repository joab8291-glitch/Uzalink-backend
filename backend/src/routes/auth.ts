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

function isConfiguredAdmin(user: { email: string | null; phone: string | null }) {
  const emailMatches = Boolean(
    env.ADMIN_EMAIL && user.email && user.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()
  );
  const phoneMatches = Boolean(
    env.ADMIN_PHONE && user.phone && user.phone.replace(/\s+/g, "") === env.ADMIN_PHONE.replace(/\s+/g, "")
  );
  return emailMatches || phoneMatches;
}

authRouter.post("/magic-link", async (req, res, next) => {
  try {
    const body = identity.parse(req.body);
    const intent = req.body?.intent === "seller" ? "seller" : "buyer";
    const email = body.email ? body.email.toLowerCase() : undefined;
    const phone = body.phone ? body.phone.trim() : undefined;

    let user = null;
    if (email) user = await prisma.user.findUnique({ where: { email } });
    if (!user && phone) user = await prisma.user.findUnique({ where: { phone } });

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            email,
            phone,
            name: body.name || "UzaLink user",
            role: intent === "seller" ? "SELLER" : "BUYER",
          },
        });
      } catch (error: any) {
        if (error?.code !== "P2002") throw error;
        user = email ? await prisma.user.findUnique({ where: { email } }) : null;
        if (!user && phone) user = await prisma.user.findUnique({ where: { phone } });
        if (!user) throw error;
      }
    }

    // Admin access is allowlisted by server-side environment variables.
    // Users cannot select ADMIN from the frontend.
    if (isConfiguredAdmin(user) && user.role !== "ADMIN") {
      user = await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    }

    if (intent === "seller" && user.role === "BUYER") {
      user = await prisma.user.update({ where: { id: user.id }, data: { role: "SELLER" } });
    }

    await prisma.magicLink.deleteMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    });

    const rawToken = randomToken();
    await prisma.magicLink.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    const loginPath = intent === "seller" ? "/#/seller-login" : "/#/login";
    const url = `${env.FRONTEND_URL}${loginPath}?token=${encodeURIComponent(rawToken)}`;

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
      accountType: intent === "seller" ? "FREE_SELLER" : "BUYER",
      message: "If the account exists, a secure login link has been sent.",
      ...(env.NODE_ENV !== "production" ? { devLink: url } : {}),
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/verify-magic-link", async (req, res, next) => {
  try {
    const token = z.string().trim().min(20).parse(req.body?.token);
    const link = await prisma.magicLink.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!link) return res.status(400).json({ ok: false, error: "Invalid or expired login link" });
    if (link.usedAt) return res.status(400).json({ ok: false, error: "This login link has already been used" });
    if (link.expiresAt.getTime() < Date.now()) return res.status(400).json({ ok: false, error: "This login link has expired" });

    await prisma.magicLink.update({ where: { id: link.id }, data: { usedAt: new Date() } });
    setSessionCookie(res, { userId: link.user.id, role: link.user.role });

    return res.status(200).json({
      ok: true,
      user: {
        id: link.user.id,
        email: link.user.email,
        phone: link.user.phone,
        name: link.user.name,
        role: link.user.role,
      },
      seller: link.user.role === "SELLER" || link.user.role === "ADMIN",
      premium: false,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ ok: false, error: "Authentication required" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        seller: true,
        subscriptions: {
          where: { status: "ACTIVE", endsAt: { gt: new Date() } },
          orderBy: { endsAt: "desc" },
          take: 1,
        },
      },
    });
    if (!user) return res.status(401).json({ ok: false, error: "User not found" });
    return res.status(200).json({
      ok: true,
      user,
      seller: user.role === "SELLER" || user.role === "ADMIN",
      premium: user.subscriptions.length > 0,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(env.COOKIE_NAME, { path: "/" });
  return res.status(200).json({ ok: true, message: "Logged out successfully" });
});
