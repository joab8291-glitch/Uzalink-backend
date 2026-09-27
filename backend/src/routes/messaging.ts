import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const messagingRouter = Router();
messagingRouter.use(requireAuth);

messagingRouter.get("/", async (req,res,next)=>{try{
 const messages=await prisma.sellerMessage.findMany({where:{recipientId:req.user!.userId},orderBy:{createdAt:"desc"},take:100,include:{sender:{select:{id:true,name:true}}}});
 res.json({messages});
}catch(e){next(e)}});

messagingRouter.post("/", requireRole("SELLER","ADMIN"), async(req,res,next)=>{try{
 const b=z.object({recipientId:z.string().min(1),subject:z.string().max(120).optional(),body:z.string().min(1).max(5000)}).parse(req.body);
 if(b.recipientId===req.user!.userId)return res.status(400).json({error:"Cannot message yourself"});
 const recipient=await prisma.user.findUnique({where:{id:b.recipientId},select:{id:true}});
 if(!recipient)return res.status(404).json({error:"Recipient not found"});
 const message=await prisma.sellerMessage.create({data:{senderId:req.user!.userId,recipientId:b.recipientId,subject:b.subject,body:b.body}});
 res.status(201).json({message});
}catch(e){next(e)}});

messagingRouter.patch("/:id/read",async(req,res,next)=>{try{
 const message=await prisma.sellerMessage.updateMany({where:{id:req.params.id,recipientId:req.user!.userId},data:{readAt:new Date()}});
 res.json({updated:message.count});
}catch(e){next(e)}});
