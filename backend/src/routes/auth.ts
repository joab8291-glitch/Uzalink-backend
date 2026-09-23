import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashToken, randomToken, setSessionCookie } from "../lib/auth.js";
import { env } from "../lib/config.js";
import { sendEmail } from "../services/notifications.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();
const identity = z.object({ email: z.string().email().optional(), phone: z.string().optional(), name: z.string().min(2).optional() }).refine(v => v.email || v.phone, "Email or phone is required");

authRouter.post("/magic-link", async (req,res,next) => { try { const p=identity.parse(req.body); const intent=req.body?.intent === "seller" ? "seller" : "buyer"; let user=await prisma.user.findFirst({ where: p.email ? { email:p.email } : { phone:p.phone } }); if(!user) user=await prisma.user.create({data:{email:p.email,phone:p.phone,name:p.name || "UzaLink user",role:intent === "seller" ? "SELLER" : "BUYER"}}); else if(intent === "seller" && user.role === "BUYER") user=await prisma.user.update({where:{id:user.id},data:{role:"SELLER"}}); const raw=randomToken(); await prisma.magicLink.create({data:{userId:user.id,tokenHash:hashToken(raw),expiresAt:new Date(Date.now()+15*60*1000)}}); const url=`${env.FRONTEND_URL}/#/seller-login?token=${raw}`; if(user.email) await sendEmail(user.id,user.email,"Your UzaLink secure login link",`Use this one-time link to sign in: ${url}\n\nIt expires in 15 minutes.`); res.json({ok:true,message:"If the account exists, a secure login link has been sent.", ...(env.NODE_ENV !== "production" ? {devLink:url}: {})}); } catch(e){next(e);} });

authRouter.post("/verify-magic-link", async(req,res,next)=>{try{const token=z.string().min(20).parse(req.body.token); const link=await prisma.magicLink.findUnique({where:{tokenHash:hashToken(token)},include:{user:true}}); if(!link||link.usedAt||link.expiresAt<Date.now()) return res.status(400).json({error:"Invalid or expired login link"}); await prisma.magicLink.update({where:{id:link.id},data:{usedAt:new Date()}}); const role=link.user.role; setSessionCookie(res,{userId:link.user.id,role}); res.json({user:{id:link.user.id,email:link.user.email,phone:link.user.phone,name:link.user.name,role}});}catch(e){next(e);}});

authRouter.get("/me",requireAuth,async(req,res,next)=>{try{const user=await prisma.user.findUnique({where:{id:req.user!.userId},include:{seller:true,subscriptions:{where:{status:"ACTIVE",endsAt:{gt:new Date()}},orderBy:{endsAt:"desc"},take:1}}}); if(!user)return res.status(401).json({error:"User not found"}); res.json({user});}catch(e){next(e);}});
authRouter.post("/logout",(_req,res)=>{res.clearCookie(env.COOKIE_NAME,{path:"/"});res.json({ok:true});});
