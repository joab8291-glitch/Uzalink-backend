import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requirePremium } from "../middleware/premium.js";
import { putPrivateObject } from "../services/storage.js";

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:100*1024*1024}}); export const productRouter=Router();
productRouter.get("/",async(req,res,next)=>{try{const products=await prisma.product.findMany({where:{status:"ACTIVE"},include:{seller:{select:{handle:true,user:{select:{name:true}}}}},orderBy:{createdAt:"desc"}});res.json({products});}catch(e){next(e);}});
productRouter.get("/:code",async(req,res,next)=>{try{const p=await prisma.product.findUnique({where:{code:req.params.code},include:{seller:{select:{handle:true,user:{select:{name:true}}}}}});if(!p||p.status!=="ACTIVE")return res.status(404).json({error:"Product not found"});res.json({product:p});}catch(e){next(e);}});
productRouter.post("/",requireAuth,requireRole("SELLER","ADMIN"),requirePremium,upload.single("file"),async(req,res,next)=>{try{if(!req.user)return;const seller=await prisma.sellerProfile.findUnique({where:{userId:req.user.userId}});if(!seller)return res.status(403).json({error:"Create seller profile first"});const b=z.object({name:z.string().min(3),description:z.string().min(12),category:z.string().min(1),kind:z.enum(["DIGITAL","SERVICE","BOOKING","EVENT","COURSE","SUBSCRIPTION","PHYSICAL","OTHER"]),priceCents:z.coerce.number().int().min(5000),instant:z.string().transform(v=>v === "true").default(false),downloadLimit:z.coerce.number().int().min(1).max(50).default(5),expiresHours:z.coerce.number().int().min(1).max(168).default(72),deliveryText:z.string().optional(),inventory:z.coerce.number().int().min(0).nullable().optional()}).parse(req.body);let key:string|undefined;if(req.file){key=`products/${seller.id}/${crypto.randomUUID()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`;await putPrivateObject(key,req.file.buffer,req.file.mimetype);}const product=await prisma.product.create({data:{...b,code:crypto.randomBytes(4).toString("hex"),sellerId:seller.id,privateFileKey:key,fileName:req.file?.originalname,fileSize:req.file?.size,status:"ACTIVE",priceCents:b.priceCents}});res.status(201).json({product});}catch(e){next(e);}});
