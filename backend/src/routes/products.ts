import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getPrivateObject, putPrivateObject } from "../services/storage.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export const productRouter = Router();

/** Public product cover. Digital files remain private. */
productRouter.get("/:code/cover", async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: {
        code: req.params.code,
        seller: { user: { role: "SELLER" } },
      },
    });

    if (!product || product.status !== "ACTIVE") {
      return res.status(404).json({ error: "Product cover not found" });
    }

    // Older published books may have an imageUrl instead of a private coverKey.
    // Keep those covers working while newer uploads use private object storage.
    if (!product.coverKey) {
      if (product.imageUrl) {
        return res.redirect(302, product.imageUrl);
      }

      return res.status(404).json({ error: "Product cover not found" });
    }

    const object = await getPrivateObject(product.coverKey);
    const contentType =
      object.ContentType ||
      "image/jpeg";

    if (object.ContentLength !== undefined) {
      res.setHeader(
        "Content-Length",
        String(object.ContentLength)
      );
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Cache-Control",
      "public, max-age=300, s-maxage=900"
    );

    if (!object.Body) {
      return res.status(404).json({
        error: "Product cover not found",
      });
    }

    const body = object.Body as any;

    if (typeof body.pipe === "function") {
      body.pipe(res);
    } else {
      const bytes = await body.transformToByteArray();
      res.end(Buffer.from(bytes));
    }

    return;
  } catch (e) {
    next(e);
  }
});

/** Public product marketplace */
productRouter.get("/", async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        status: "ACTIVE",
        seller: { user: { role: "SELLER" } },
      },
      include: {
        seller: {
          select: {
            handle: true,
            bio: true,
            avatarUrl: true,
            verifiedAt: true,
            featured: true,
            followersCount: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
    });

    res.json({ products });
  } catch (e) {
    next(e);
  }
});

/** Public single product */
productRouter.get("/:code", async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: {
        code: req.params.code,
        seller: { user: { role: "SELLER" } },
      },
      include: {
        seller: {
          select: {
            handle: true,
            user: { select: { name: true } },
          },
        },
      },
    });

    if (!product || product.status !== "ACTIVE") {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ product });
  } catch (e) {
    next(e);
  }
});

productRouter.post("/", requireAuth, requireRole("SELLER"), upload.fields([{ name: "file", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req,res,next)=>{
 try{
  if(!req.user)return res.status(401).json({error:"Authentication required"});
  const seller=await prisma.sellerProfile.findUnique({where:{userId:req.user.userId}});
  if(!seller)return res.status(403).json({error:"Create your seller profile before adding products",code:"SELLER_PROFILE_REQUIRED"});
  const body=z.object({
   name:z.string().min(3),description:z.string().min(12),category:z.string().min(1),
   kind:z.enum(["DIGITAL","SERVICE","BOOKING","EVENT","COURSE","SUBSCRIPTION","PHYSICAL","OTHER"]),
   priceCents:z.coerce.number().int().min(5000),
   instant:z.union([z.boolean(),z.string()]).transform(v=>v===true||v==="true").default(false),
   downloadLimit:z.coerce.number().int().min(1).max(50).default(5),
   expiresHours:z.coerce.number().int().min(1).max(168).default(72),
   deliveryText:z.string().optional(),inventory:z.coerce.number().int().min(0).nullable().optional()
  }).parse(req.body);
  const files=req.files as {[fieldname:string]:Express.Multer.File[]|undefined}|undefined;
  const productFile=files?.file?.[0],coverFile=files?.cover?.[0];
  if(body.kind==="DIGITAL"&&!productFile)return res.status(400).json({error:"Digital product file is required"});
  let privateFileKey:string|undefined,coverKey:string|undefined;
  if(productFile){privateFileKey=`products/${seller.id}/${crypto.randomUUID()}-${productFile.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`;await putPrivateObject(privateFileKey,productFile.buffer,productFile.mimetype);}
  if(coverFile){coverKey=`covers/${seller.id}/${crypto.randomUUID()}-${coverFile.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`;await putPrivateObject(coverKey,coverFile.buffer,coverFile.mimetype);}
  const product=await prisma.product.create({data:{
   name:body.name,description:body.description,category:body.category,kind:body.kind,priceCents:body.priceCents,
   instant:body.kind==="DIGITAL"?body.instant:false,downloadLimit:body.downloadLimit,expiresHours:body.expiresHours,
   deliveryText:body.deliveryText,inventory:body.inventory,code:crypto.randomBytes(4).toString("hex"),sellerId:seller.id,
   privateFileKey,fileName:productFile?.originalname,fileSize:productFile?.size,coverKey,coverFileName:coverFile?.originalname,status:"ACTIVE"
  }});
  res.status(201).json({product});
 }catch(e){next(e)}
});
