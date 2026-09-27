import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

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
    const review = await prisma.review.upsert({
      where: { userId_productId: { userId: req.user!.id, productId: product.id } },
      create: { userId: req.user!.id, productId: product.id, rating, title: req.body.title?.trim() || null, body: req.body.body?.trim() || null },
      update: { rating, title: req.body.title?.trim() || null, body: req.body.body?.trim() || null },
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
    const product = await prisma.product.findUnique({ where: { code: req.params.code } });
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
    await prisma.sellerFollow.upsert({
      where: { followerId_sellerId: { followerId: req.user!.id, sellerId: seller.id } },
      create: { followerId: req.user!.id, sellerId: seller.id },
      update: {},
    });
    await prisma.sellerProfile.updateMany({ where: { userId: seller.id }, data: { followersCount: { increment: 1 } } });
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
