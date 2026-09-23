import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { stkPush } from "../services/mpesa.js";
import { env } from "../lib/config.js";

export const subscriptionRouter=Router();subscriptionRouter.use(requireAuth);
subscriptionRouter.get("/me",async(req,res,next)=>{try{const sub=await prisma.subscription.findFirst({where:{userId:req.user!.userId,status:"ACTIVE",endsAt:{gt:new Date()}},orderBy:{endsAt:"desc"}});res.json({premium:Boolean(sub),subscription:sub});}catch(e){next(e);}});
subscriptionRouter.post("/start",async(req,res,next)=>{try{const b=z.object({phone:z.string()}).parse(req.body);const cents=Math.round(env.PREMIUM_PRICE_KES*100);const pending=await prisma.payment.create({data:{orderId:(await prisma.order.create({data:{publicId:`PREM-${Date.now()}`,buyerId:req.user!.userId,amountCents:cents,buyerPhone:b.phone,status:"PENDING"}})).id,amountCents:cents,phone:b.phone}});await prisma.subscription.create({data:{userId:req.user!.userId,status:"PENDING",priceCents:cents,paymentId:pending.id}});const mp=await stkPush({phone:b.phone,amountCents:cents,accountReference:`PREM${req.user!.userId.slice(-6)}`,description:"UzaLink Premium"});await prisma.payment.update({where:{id:pending.id},data:{merchantRequestId:mp.MerchantRequestID,checkoutRequestId:mp.CheckoutRequestID}});res.json({checkoutRequestId:mp.CheckoutRequestID});}catch(e){next(e);}});
