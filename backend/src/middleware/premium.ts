import type {NextFunction,Request,Response} from "express";
import {prisma} from "../lib/prisma.js";
export async function requirePremium(req:Request,res:Response,next:NextFunction){if(!req.user)return res.status(401).json({error:"Authentication required"});const sub=await prisma.subscription.findFirst({where:{userId:req.user.userId,status:"ACTIVE",endsAt:{gt:new Date()}}});if(!sub)return res.status(402).json({error:"Active Premium subscription required"});next();}
