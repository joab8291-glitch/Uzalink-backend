import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getPrivateObject, putPrivateObject } from "../services/storage.js";
import { normalizePhone } from "../services/mpesa.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export const productRouter = Router();

/** Public cover endpoint. Uses findFirst because the lookup includes a relation filter. */
productRouter.get("/:code/cover", async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({
      where: {
        code: req.params.code,
        status: "ACTIVE",
        seller: { user: { role: "SELLER" } },
      },
      select: {
        coverKey: true,
        imageUrl: true,
        fileName: true,
      },
    });

    if (!product) return res.status(404).json({ error: "Product cover not found" });

    if (!product.coverKey) {
      if (product.imageUrl) return res.redirect(302, product.imageUrl);
      return res.status(404).json({ error: "Product cover not found" });
    }

    const object = await getPrivateObject(product.coverKey);
    if (!object.Body) return res.status(404).json({ error: "Product cover not found" });

    res.status(200);
    res.setHeader("Content-Type", object.ContentType || "image/jpeg");
    if (object.ContentLength !== undefined) {
      res.setHeader("Content-Length", String(object.ContentLength));
    }
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=900, stale-while-revalidate=3600");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    const body = object.Body as any;
    if (typeof body.pipe === "function") {
      body.on("error", next);
      body.pipe(res);
    } else {
      res.end(Buffer.from(await body.transformToByteArray()));
    }
  } catch (e) {
    next(e);
  }
});

productRouter.get("/", async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      where: { status: "ACTIVE", seller: { user: { role: "SELLER" } } },
      include: { seller: { select: { handle: true, bio: true, avatarUrl: true, verifiedAt: true, featured: true, followersCount: true, user: { select: { id: true, name: true } } } } },
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
    });
    res.json({ products });
  } catch (e) { next(e); }
});

productRouter.get("/:code", async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({ where: { code: req.params.code, seller: { user: { role: "SELLER" } } }, include: { seller: { select: { handle: true, user: { select: { name: true } } } } } });
    if (!product || product.status !== "ACTIVE") return res.status(404).json({ error: "Product not found" });
    res.json({ product });
  } catch (e) { next(e); }
});

const productSchema = z.object({
  shopName: z.string().trim().min(2).max(80).optional(),
  paymentNumber: z.string().min(10).max(15).optional(),
  name: z.string().min(3),
  description: z.string().min(12),
  category: z.string().min(1),
  kind: z.enum(["DIGITAL", "SERVICE", "BOOKING", "EVENT", "COURSE", "SUBSCRIPTION", "PHYSICAL", "OTHER"]),
  priceCents: z.coerce.number().int().min(5000),
  instant: z.union([z.boolean(), z.string()]).transform(v => v === true || v === "true").default(false),
  downloadLimit: z.coerce.number().int().min(1).max(50).default(5),
  expiresHours: z.coerce.number().int().min(1).max(168).default(72),
  deliveryText: z.string().optional(),
  inventory: z.coerce.number().int().min(0).nullable().optional(),
});

function sellerHandle(shopName: string) {
  const base = shopName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) || "seller";
  return `${base}_${crypto.randomBytes(3).toString("hex")}`;
}

/** Sell Today supports FREE sellers without dashboard/login access. */
productRouter.post("/", upload.fields([{ name: "file", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req: any, res, next) => {
  try {
    const body = productSchema.parse(req.body);
    const files = req.files as { [field: string]: Express.Multer.File[] | undefined } | undefined;
    const productFile = files?.file?.[0];
    const coverFile = files?.cover?.[0];
    if (body.kind === "DIGITAL" && !productFile) return res.status(400).json({ error: "Digital product file is required" });

    let seller;
    if (req.user?.userId) {
      seller = await prisma.sellerProfile.findUnique({ where: { userId: req.user.userId } });
      if (!seller) return res.status(403).json({ error: "Seller profile required", code: "SELLER_PROFILE_REQUIRED" });
    } else {
      if (!body.shopName || !body.paymentNumber) return res.status(400).json({ error: "Shop name and M-Pesa number are required" });
      const phone = normalizePhone(body.paymentNumber);
      let user = await prisma.user.findUnique({ where: { phone } });
      if (user?.role === "ADMIN") return res.status(403).json({ error: "Admin account cannot be used for public selling" });
      if (!user) {
        user = await prisma.user.create({ data: { phone, name: body.shopName, role: "SELLER" } });
      } else if (user.role !== "SELLER") {
        user = await prisma.user.update({ where: { id: user.id }, data: { name: body.shopName, role: "SELLER" } });
      }
      seller = await prisma.sellerProfile.findUnique({ where: { userId: user.id } });
      if (!seller) seller = await prisma.sellerProfile.create({ data: { userId: user.id, handle: sellerHandle(body.shopName), paymentNumber: phone } });
      else seller = await prisma.sellerProfile.update({ where: { id: seller.id }, data: { paymentNumber: phone } });
    }

    let privateFileKey: string | undefined;
    let coverKey: string | undefined;
    if (productFile) {
      privateFileKey = `products/${seller.id}/${crypto.randomUUID()}-${productFile.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      await putPrivateObject(privateFileKey, productFile.buffer, productFile.mimetype);
    }
    if (coverFile) {
      coverKey = `covers/${seller.id}/${crypto.randomUUID()}-${coverFile.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      await putPrivateObject(coverKey, coverFile.buffer, coverFile.mimetype);
    }

    const product = await prisma.product.create({
      data: {
        name: body.name.trim(), description: body.description.trim(), category: body.category.trim(), kind: body.kind,
        priceCents: body.priceCents, instant: body.kind === "DIGITAL" ? body.instant : false,
        downloadLimit: body.downloadLimit, expiresHours: body.expiresHours, deliveryText: body.deliveryText,
        inventory: body.inventory, code: crypto.randomBytes(4).toString("hex"), sellerId: seller.id,
        privateFileKey, fileName: productFile?.originalname, fileSize: productFile?.size,
        coverKey, coverFileName: coverFile?.originalname, status: "ACTIVE",
      },
      include: { seller: { select: { id: true, handle: true } } },
    });
    res.status(201).json({ product, magicLink: `/magic/${product.code}` });
  } catch (e) { next(e); }
});
