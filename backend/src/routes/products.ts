import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {
  requireAuth,
  requireRole,
} from "../middleware/auth.js";
import { putPrivateObject } from "../services/storage.js";

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

export const productRouter = Router();

/**
 * Public product marketplace
 */
productRouter.get(
  "/",
  async (req, res, next) => {
    try {
      const products =
        await prisma.product.findMany({
          where: {
            status: "ACTIVE",
          },

          include: {
            seller: {
              select: {
                handle: true,

                user: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      res.json({
        products,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Public single product
 */
productRouter.get(
  "/:code",
  async (req, res, next) => {
    try {
      const product =
        await prisma.product.findUnique({
          where: {
            code: req.params.code,
          },

          include: {
            seller: {
              select: {
                handle: true,

                user: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        });

      if (
        !product ||
        product.status !== "ACTIVE"
      ) {
        return res.status(404).json({
          error: "Product not found",
        });
      }

      res.json({
        product,
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Create product
 *
 * FREE SELLERS ARE ALLOWED.
 *
 * Premium is no longer required to list products.
 */
productRouter.post(
  "/",
  requireAuth,
  requireRole("SELLER", "ADMIN"),
  upload.single("file"),

  async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          error: "Authentication required",
        });
      }

      const seller =
        await prisma.sellerProfile.findUnique({
          where: {
            userId: req.user.userId,
          },
        });

      if (!seller) {
        return res.status(403).json({
          error:
            "Create your seller profile before adding products",
          code: "SELLER_PROFILE_REQUIRED",
        });
      }

      const body = z
        .object({
          name: z.string().min(3),

          description: z
            .string()
            .min(12),

          category: z
            .string()
            .min(1),

          kind: z.enum([
            "DIGITAL",
            "SERVICE",
            "BOOKING",
            "EVENT",
            "COURSE",
            "SUBSCRIPTION",
            "PHYSICAL",
            "OTHER",
          ]),

          priceCents: z.coerce
            .number()
            .int()
            .min(5000),

          instant: z
            .union([
              z.boolean(),
              z.string(),
            ])
            .transform(
              (value) =>
                value === true ||
                value === "true"
            )
            .default(false),

          downloadLimit: z.coerce
            .number()
            .int()
            .min(1)
            .max(50)
            .default(5),

          expiresHours: z.coerce
            .number()
            .int()
            .min(1)
            .max(168)
            .default(72),

          deliveryText:
            z.string().optional(),

          inventory: z.coerce
            .number()
            .int()
            .min(0)
            .nullable()
            .optional(),
        })
        .parse(req.body);

      let privateFileKey:
        | string
        | undefined;

      if (req.file) {
        privateFileKey =
          `products/${seller.id}/${crypto.randomUUID()}-${req.file.originalname.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          )}`;

        await putPrivateObject(
          privateFileKey,
          req.file.buffer,
          req.file.mimetype
        );
      }

      const product =
        await prisma.product.create({
          data: {
            name: body.name,
            description:
              body.description,
            category: body.category,
            kind: body.kind,
            priceCents:
              body.priceCents,

            instant:
              body.instant,

            downloadLimit:
              body.downloadLimit,

            expiresHours:
              body.expiresHours,

            deliveryText:
              body.deliveryText,

            inventory:
              body.inventory,

            code: crypto
              .randomBytes(4)
              .toString("hex"),

            sellerId: seller.id,

            privateFileKey,

            fileName:
              req.file?.originalname,

            fileSize:
              req.file?.size,

            status: "ACTIVE",
          },
        });

      res.status(201).json({
        product,
      });
    } catch (e) {
      next(e);
    }
  }
);
