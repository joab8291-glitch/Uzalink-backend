import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const engagementRouter = Router();

engagementRouter.get("/products/:code/reviews", async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { code: req.params.code } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const reviews = await prisma.review.findMany({
      where: { productId: product.id, approved: true },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, name: true } } },
    });
    res.json({ reviews });
  } catch (e) { next(e); }
});

engagementRouter.post("/products/:code/reviews", requireAuth, async (req, res, next) => {
  try {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5" });
    const product = await prisma.product.findUnique({ where: { code: req.params.code } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const purchase = await prisma.order.findFirst({ where: { buyerId: req.user!.id, status: { in: ["PAID", "FULFILLED"] }, items: { some: { productId: product.id } } } });
    if (!purchase) return res.status(403).json({ error: "You can review a product only after purchasing it" });
    const review = await prisma.review.upsert({
      where: { userId_productId: { userId: req.user!.id, productId: product.id } },
      create: { userId: req.user!.id, productId: product.id, orderId: purchase.id, rating, title: req.body.title?.trim() || null, body: req.body.body?.trim() || null },
      update: { rating, title: req.body.title?.trim() || null, body: req.body.body?.trim() || null, orderId: purchase.id },
    });
    const aggregate = await prisma.review.aggregate({ where: { productId: product.id, approved: true }, _avg: { rating: true } });
    await prisma.product.update({ where: { id: product.id }, data: { rating: aggregate._avg.rating ?? rating } });
    res.status(201).json({ review });
  } catch (e) { next(e); }
});

engagementRouter.get("/wishlist", requireAuth, async (req, res, next) => {
  try {
    const items = await prisma.wishlist.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, include: { product: true } });
    res.json({ items });
  } catch (e) { next(e); }
});

engagementRouter.post("/wishlist/:code", requireAuth, async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { code: req.params.code, status: "ACTIVE" } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const item = await prisma.wishlist.upsert({
      where: { userId_productId: { userId: req.user!.id, productId: product.id } },
      create: { userId: req.user!.id, productId: product.id },
      update: {},
    });
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

engagementRouter.delete("/wishlist/:code", requireAuth, async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { code: req.params.code } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    await prisma.wishlist.deleteMany({ where: { userId: req.user!.id, productId: product.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

engagementRouter.post("/sellers/:sellerId/follow", requireAuth, async (req, res, next) => {
  try {
    if (req.user!.id === req.params.sellerId) return res.status(400).json({ error: "You cannot follow yourself" });
    const seller = await prisma.user.findFirst({ where: { id: req.params.sellerId, role: "SELLER" } });
    if (!seller) return res.status(404).json({ error: "Seller not found" });
    const existing = await prisma.sellerFollow.findUnique({ where: { followerId_sellerId: { followerId: req.user!.id, sellerId: seller.id } } });
    if (!existing) {
      await prisma.sellerFollow.create({ data: { followerId: req.user!.id, sellerId: seller.id } });
      await prisma.sellerProfile.updateMany({ where: { userId: seller.id }, data: { followersCount: { increment: 1 } } });
    }
    res.status(201).json({ following: true });
  } catch (e) { next(e); }
});

engagementRouter.delete("/sellers/:sellerId/follow", requireAuth, async (req, res, next) => {
  try {
    const deleted = await prisma.sellerFollow.deleteMany({ where: { followerId: req.user!.id, sellerId: req.params.sellerId } });
    if (deleted.count) await prisma.sellerProfile.updateMany({ where: { userId: req.params.sellerId }, data: { followersCount: { decrement: 1 } } });
    res.status(204).send();
  } catch (e) { next(e); }
});

engagementRouter.get("/sellers/:sellerId", async (req, res, next) => {
  try {
    const seller = await prisma.user.findFirst({
      where: { id: req.params.sellerId, role: "SELLER" },
      select: { id: true, name: true, seller: { select: { handle: true, bio: true, avatarUrl: true, verifiedAt: true, featured: true, followersCount: true } } },
    });
    if (!seller) return res.status(404).json({ error: "Seller not found" });
    res.json({ seller });
  } catch (e) { next(e); }
});

engagementRouter.get("/coupons/:code", async (req, res, next) => {
  try {
    const coupon = await prisma.coupon.findUnique({ where: { code: req.params.code.trim().toUpperCase() }, select: { code: true, sellerId: true, percentOff: true, amountOffCents: true, maxRedemptions: true, redeemedCount: true, active: true, startsAt: true, endsAt: true } });
    const now = new Date();
    if (!coupon || !coupon.active || (coupon.startsAt && coupon.startsAt > now) || (coupon.endsAt && coupon.endsAt < now) || (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions)) {
      return res.status(404).json({ error: "Coupon is invalid or expired" });
    }
    res.json({ coupon: { ...coupon, availableRedemptions: coupon.maxRedemptions === null ? null : coupon.maxRedemptions - coupon.redeemedCount } });
  } catch (e) { next(e); }
});

engagementRouter.post("/coupons", requireAuth, requireRole("SELLER", "ADMIN"), async (req, res, next) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();
    const percentOff = req.body.percentOff == null ? null : Number(req.body.percentOff);
    const amountOffCents = req.body.amountOffCents == null ? null : Number(req.body.amountOffCents);
    const maxRedemptions = req.body.maxRedemptions == null ? null : Number(req.body.maxRedemptions);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: "Coupon code must be 3-32 letters, numbers, _ or -" });
    if ((percentOff === null) === (amountOffCents === null)) return res.status(400).json({ error: "Provide either percentOff or amountOffCents" });
    if (percentOff !== null && (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100)) return res.status(400).json({ error: "percentOff must be 1-100" });
    if (amountOffCents !== null && (!Number.isInteger(amountOffCents) || amountOffCents < 1)) return res.status(400).json({ error: "amountOffCents must be positive" });
    if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) return res.status(400).json({ error: "maxRedemptions must be positive" });

    let sellerId: string | null = null;
    if (req.user!.role === "SELLER") {
      const seller = await prisma.sellerProfile.findUnique({ where: { userId: req.user!.id } });
      if (!seller) return res.status(400).json({ error: "Seller profile not found" });
      sellerId = seller.id;
    } else if (req.body.sellerId) {
      const seller = await prisma.sellerProfile.findUnique({ where: { id: String(req.body.sellerId) } });
      if (!seller) return res.status(404).json({ error: "Seller profile not found" });
      sellerId = seller.id;
    }

    const coupon = await prisma.coupon.create({
      data: { code, sellerId, percentOff, amountOffCents, maxRedemptions, startsAt: req.body.startsAt ? new Date(req.body.startsAt) : null, endsAt: req.body.endsAt ? new Date(req.body.endsAt) : null },
    });
    res.status(201).json({ coupon });
  } catch (e) { next(e); }
});

engagementRouter.patch("/coupons/:code", requireAuth, requireRole("SELLER", "ADMIN"), async (req, res, next) => {
  try {
    const coupon = await prisma.coupon.findUnique({ where: { code: req.params.code.trim().toUpperCase() } });
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    if (req.user!.role === "SELLER") {
      const seller = await prisma.sellerProfile.findUnique({ where: { userId: req.user!.id } });
      if (!seller || coupon.sellerId !== seller.id) return res.status(403).json({ error: "You can only manage your own coupons" });
    }
    const active = req.body.active === undefined ? undefined : Boolean(req.body.active);
    const updated = await prisma.coupon.update({ where: { id: coupon.id }, data: { active } });
    res.json({ coupon: updated });
  } catch (e) { next(e); }
});

engagementRouter.post("/referrals", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.referral.findFirst({ where: { referrerId: req.user!.id, status: "PENDING" } });
    if (existing) return res.json({ referral: existing });
    const referral = await prisma.referral.create({
      data: { referrerId: req.user!.id, code: `REF-${crypto.randomBytes(5).toString("hex").toUpperCase()}` },
    });
    res.status(201).json({ referral });
  } catch (e) { next(e); }
});

engagementRouter.get("/referrals/me", requireAuth, async (req, res, next) => {
  try {
    const referrals = await prisma.referral.findMany({ where: { referrerId: req.user!.id }, orderBy: { createdAt: "desc" } });
    res.json({ referrals });
  } catch (e) { next(e); }
});

engagementRouter.get("/referrals/:code", async (req, res, next) => {
  try {
    const referral = await prisma.referral.findUnique({ where: { code: req.params.code } });
    if (!referral) return res.status(404).json({ error: "Referral code not found" });
    res.json({ referral: { code: referral.code, status: referral.status } });
  } catch (e) { next(e); }
});
