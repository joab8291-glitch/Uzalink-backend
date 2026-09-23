import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
const prisma=new PrismaClient();
async function main(){const email=process.env.ADMIN_EMAIL;if(!email) return;const passwordHash=await bcrypt.hash(process.env.ADMIN_BOOTSTRAP_PASSWORD || crypto.randomUUID(),12);await prisma.user.upsert({where:{email},update:{role:"ADMIN",name:process.env.ADMIN_NAME||"UzaLink Admin"},create:{email,role:"ADMIN",name:process.env.ADMIN_NAME||"UzaLink Admin",passwordHash}});console.log(`Admin ensured: ${email}`)}
main().finally(()=>prisma.$disconnect());
