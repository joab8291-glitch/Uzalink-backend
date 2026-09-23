import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { randomToken, hashToken } from "../lib/auth.js";
import { signedDownloadUrl } from "./storage.js";
import { sendEmail, sendSms } from "./notifications.js";

const COMMISSION = 5;
export async function createOrder(productId: string, buyer: { name?: string; phone: string; email?: string; address?: string }, buyerId?: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, status: "ACTIVE" } });
  if (!product) throw new Error("Product not found or unavailable");
  if (product.inventory !== null && product.inventory < 1) throw new Error("Product is out of stock");
  const commission = Math.round(product.priceCents * COMMISSION / 100);
  return prisma.order.create({ data: { publicId: `UZL-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, buyerId, buyerName: buyer.name, buyerPhone: buyer.phone, buyerEmail: buyer.email, metadata: buyer.address ? { address: buyer.address } : undefined, amountCents: product.priceCents, commissionCents: commission, sellerNetCents: product.priceCents - commission, productId: product.id, items: { create: { productId: product.id, quantity: 1, unitPriceCents: product.priceCents, commissionCents: commission, sellerNetCents: product.priceCents - commission } } }, include: { items: true } });
}
export async function fulfillPaidOrder(orderId: string, paymentId: string, receipt?: string) {
  const result = await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: { include: { seller: { include: { user: true } } } } } } } });
    if (!order) throw new Error("Order not found");
    if (order.status === "PAID" || order.status === "FULFILLED") {
  return { order, downloadToken: undefined };
}
    const item = order.items[0];
    const seller = item.product.seller;
    await tx.payment.update({ where: { id: paymentId }, data: { status: "SUCCESS", receipt } });
    await tx.order.update({ where: { id: order.id }, data: { status: item.product.kind === "PHYSICAL" || item.product.kind === "SERVICE" || item.product.kind === "BOOKING" ? "PAID" : "PAID", paidAt: new Date() } });
    await tx.sellerProfile.update({ where: { id: seller.id }, data: { balanceCents: { increment: item.sellerNetCents }, lifetimeSalesCents: { increment: item.sellerNetCents }, totalOrders: { increment: 1 } } });
    await tx.product.update({ where: { id: item.product.id }, data: { salesCount: { increment: 1 }, inventory: item.product.inventory === null ? null : Math.max(0, item.product.inventory - 1) } });
    if (item.product.kind === "BOOKING" || item.product.kind === "SERVICE") {
      await tx.booking.upsert({ where: { orderId: order.id }, update: {}, create: { orderId: order.id, productId: item.product.id, status: "CONFIRMED" } });
    }
    if (item.product.kind === "PHYSICAL") {
      const metadata = (order.metadata || {}) as { address?: string };
      await tx.delivery.upsert({ where: { orderId: order.id }, update: {}, create: { orderId: order.id, productId: item.product.id, status: "PROCESSING", recipientName: order.buyerName, phone: order.buyerPhone, address: metadata.address } });
    }
    let downloadToken: string | undefined;
    if (item.product.instant && item.product.privateFileKey) {
      downloadToken = randomToken();
      await tx.downloadGrant.create({ data: { orderId: order.id, productId: item.product.id, userId: order.buyerId, tokenHash: hashToken(downloadToken), expiresAt: new Date(Date.now() + item.product.expiresHours * 3600000), maxDownloads: item.product.downloadLimit } });
    }
    return { order, downloadToken };
  });
  const order = result.order;
  const item = order.items[0];
  const download = result.downloadToken ? `\nDownload securely: ${process.env.PUBLIC_API_URL || ""}/api/orders/download/${result.downloadToken}` : "";
  if (order.buyerEmail) await sendEmail(order.buyerId, order.buyerEmail, "UzaLink payment confirmed", `Your payment for ${item.product.name} was confirmed. Order ${order.publicId}.${download}`);
  if (order.buyerPhone) await sendSms(order.buyerId, order.buyerPhone, `UzaLink: payment confirmed for ${item.product.name}. Order ${order.publicId}.`);
  return order;
}
export async function issueDownload(grantToken: string, ipHash?: string, userAgent?: string) {
  const grant = await prisma.downloadGrant.findUnique({ where: { tokenHash: hashToken(grantToken) }, include: { product: true, order: true } });
  if (!grant) throw new Error("Download link is invalid");
  if (grant.order.status !== "PAID" && grant.order.status !== "FULFILLED") throw new Error("Payment not confirmed");
  if (grant.expiresAt.getTime() < Date.now()) throw new Error("Download link has expired");
  if (grant.downloadCount >= grant.maxDownloads) throw new Error("Download limit reached");
  if (!grant.product.privateFileKey) throw new Error("No private file is attached to this product");
  await prisma.$transaction([prisma.downloadGrant.update({ where: { id: grant.id }, data: { downloadCount: { increment: 1 }, lastDownloadedAt: new Date() } }), prisma.downloadEvent.create({ data: { grantId: grant.id, ipHash, userAgent } })]);
  return signedDownloadUrl(grant.product.privateFileKey, grant.product.fileName || "download", 300);
}
