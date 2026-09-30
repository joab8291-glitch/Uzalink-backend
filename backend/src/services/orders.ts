import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { randomToken, hashToken } from "../lib/auth.js";
import { signedDownloadUrl } from "./storage.js";
import { sendEmail, sendSms } from "./notifications.js";

const COMMISSION = 5;

function normalizeBuyerPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return `0${digits.slice(3)}`;
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) return `0${digits}`;
  return digits;
}

async function ensureBuyerUser(
  tx: any,
  input: { name?: string | null; phone: string; email?: string | null }
) {
  const phone = normalizeBuyerPhone(input.phone);
  const email = input.email?.trim().toLowerCase() || undefined;

  let user = await tx.user.findUnique({ where: { phone } });
  if (!user && email) user = await tx.user.findUnique({ where: { email } });

  if (!user) {
    try {
      user = await tx.user.create({
        data: {
          name: input.name?.trim() || "UzaLink customer",
          phone,
          email,
          role: "BUYER",
        },
      });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      user = await tx.user.findUnique({ where: { phone } });
      if (!user && email) user = await tx.user.findUnique({ where: { email } });
      if (!user) throw error;
    }
  }

  return user;
}

export async function createOrder(
  productId: string,
  buyer: {
    name?: string;
    phone: string;
    email?: string;
    address?: string;
  },
  buyerId?: string,
  couponCode?: string,
  referralCode?: string
) {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      status: "ACTIVE",
      seller: { user: { role: "SELLER" } },
    },
  });

  if (!product) throw new Error("Product not found or unavailable");
  if (product.inventory !== null && product.inventory < 1) throw new Error("Product is out of stock");

  let finalPrice = product.priceCents;
  let amountSavedCents = 0;
  let couponId: string | undefined;

  if (couponCode) {
    const coupon = await prisma.coupon.findUnique({ where: { code: couponCode.trim().toUpperCase() } });
    const now = new Date();
    if (!coupon || !coupon.active || (coupon.startsAt && coupon.startsAt > now) || (coupon.endsAt && coupon.endsAt < now)) {
      throw new Error("Coupon is invalid or expired");
    }
    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
      throw new Error("Coupon redemption limit reached");
    }
    if (coupon.sellerId && coupon.sellerId !== product.sellerId) {
      throw new Error("Coupon is not valid for this product");
    }
    if (buyerId) {
      const used = await prisma.couponRedemption.findFirst({ where: { couponId: coupon.id, userId: buyerId } });
      if (used) throw new Error("You have already used this coupon");
    }
    if (coupon.percentOff !== null) amountSavedCents = Math.floor(product.priceCents * coupon.percentOff / 100);
    if (coupon.amountOffCents !== null) amountSavedCents = Math.max(amountSavedCents, coupon.amountOffCents);
    amountSavedCents = Math.min(Math.max(amountSavedCents, 0), product.priceCents);
    finalPrice = product.priceCents - amountSavedCents;
    couponId = coupon.id;
  }

  let referralId: string | undefined;
  if (referralCode) {
    const referral = await prisma.referral.findUnique({ where: { code: referralCode.trim().toUpperCase() } });
    if (referral && referral.referrerId !== buyerId && referral.status === "PENDING") referralId = referral.id;
  }

  const commission = Math.round((finalPrice * COMMISSION) / 100);
  const sellerNet = finalPrice - commission;

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        publicId: `UZL-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
        buyerId,
        buyerName: buyer.name,
        buyerPhone: normalizeBuyerPhone(buyer.phone),
        buyerEmail: buyer.email?.trim().toLowerCase(),
        metadata: buyer.address || referralId || couponId ? { ...(buyer.address ? { address: buyer.address } : {}), ...(referralId ? { referralCode: referralCode!.trim().toUpperCase() } : {}), ...(couponId ? { couponCode: couponCode!.trim().toUpperCase(), couponId } : {}) } : undefined,
        amountCents: finalPrice,
        commissionCents: commission,
        sellerNetCents: sellerNet,
        productId: product.id,
        items: { create: { productId: product.id, quantity: 1, unitPriceCents: finalPrice, commissionCents: commission, sellerNetCents: sellerNet } },
      },
      include: { items: true },
    });

    return order;
  });
}

export async function fulfillPaidOrder(
  orderId: string,
  paymentId: string,
  receipt?: string
) {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { include: { seller: { include: { user: true } } } } } } },
    });
    if (!order) throw new Error("Order not found");
    if (order.status === "PAID" || order.status === "FULFILLED") return { order, downloadToken: undefined };

    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "PAID", paidAt: new Date() },
    });
    if (claimed.count !== 1) return { order, downloadToken: undefined };

    const item = order.items[0];
    const seller = item.product.seller;

    await tx.payment.update({ where: { id: paymentId }, data: { status: "SUCCESS", receipt } });

    /* Register the buyer as a real UzaLink customer as soon as payment succeeds. */
    let buyerId = order.buyerId;
    if (!buyerId) {
      const customer = await ensureBuyerUser(tx, {
        name: order.buyerName,
        phone: order.buyerPhone,
        email: order.buyerEmail,
      });
      buyerId = customer.id;
      await tx.order.update({ where: { id: order.id }, data: { buyerId } });
      order.buyerId = buyerId;
    }

    const metadata = (order.metadata || {}) as { referralCode?: string; couponId?: string };
    if (metadata.couponId) {
      const existingRedemption = await tx.couponRedemption.findFirst({
        where: { couponId: metadata.couponId, orderId: order.id },
      });
      if (!existingRedemption) {
        const coupon = await tx.coupon.findUnique({ where: { id: metadata.couponId } });
        if (coupon && coupon.active) {
          const redemption = await tx.coupon.updateMany({
            where: {
              id: coupon.id,
              active: true,
              ...(coupon.maxRedemptions === null ? {} : { redeemedCount: { lt: coupon.maxRedemptions } }),
            },
            data: { redeemedCount: { increment: 1 } },
          });
          if (redemption.count === 1) {
            await tx.couponRedemption.create({
              data: {
                couponId: coupon.id,
                userId: buyerId,
                productId: item.product.id,
                orderId: order.id,
                amountSavedCents: Math.max(0, item.product.priceCents - item.unitPriceCents),
              },
            });
          }
        }
      }
    }

    if (buyerId) {
      const referralCode = metadata.referralCode?.trim().toUpperCase();
      if (referralCode) {
        const referral = await tx.referral.findUnique({ where: { code: referralCode } });
        if (referral && referral.status === "PENDING" && referral.referrerId !== buyerId) {
          const completed = await tx.referral.updateMany({
            where: { id: referral.id, status: "PENDING", referrerId: { not: buyerId } },
            data: { referredId: buyerId, status: "COMPLETED", completedAt: new Date() },
          });
          if (completed.count === 1) {
            const referrer = await tx.user.findUnique({ where: { id: referral.referrerId }, include: { seller: true } });
            const rate = referrer?.seller?.affiliateEnabled ? Math.max(0, Math.min(20, referrer.seller.affiliateRate)) : 0;
            const reward = Math.floor(item.sellerNetCents * rate / 100);
            if (reward > 0) {
              await tx.affiliateCommission.create({
                data: { referralId: referral.id, affiliateId: referral.referrerId, orderId: order.id, amountCents: reward },
              });
            }
          }
        }
      }
    }

    await tx.sellerProfile.update({
      where: { id: seller.id },
      data: { balanceCents: { increment: item.sellerNetCents }, lifetimeSalesCents: { increment: item.sellerNetCents }, totalOrders: { increment: 1 } },
    });

    if (item.product.inventory !== null) {
      const stock = await tx.product.updateMany({
        where: { id: item.product.id, inventory: { gt: 0 } },
        data: { salesCount: { increment: 1 }, inventory: { decrement: 1 } },
      });
      if (stock.count !== 1) throw new Error("Product is out of stock");
    } else {
      await tx.product.update({ where: { id: item.product.id }, data: { salesCount: { increment: 1 } } });
    }

    if (item.product.kind === "BOOKING" || item.product.kind === "SERVICE") {
      await tx.booking.upsert({ where: { orderId: order.id }, update: {}, create: { orderId: order.id, productId: item.product.id, status: "CONFIRMED" } });
    }

    if (item.product.kind === "PHYSICAL") {
      const addressMetadata = (order.metadata || {}) as { address?: string };
      await tx.delivery.upsert({
        where: { orderId: order.id },
        update: {},
        create: { orderId: order.id, productId: item.product.id, status: "PROCESSING", recipientName: order.buyerName, phone: order.buyerPhone, address: addressMetadata.address },
      });
    }

    let downloadToken: string | undefined;
    if (item.product.instant && item.product.privateFileKey) {
      downloadToken = randomToken();
      await tx.downloadGrant.create({
        data: {
          orderId: order.id,
          productId: item.product.id,
          userId: buyerId,
          tokenHash: hashToken(downloadToken),
          expiresAt: new Date(Date.now() + item.product.expiresHours * 3600000),
          maxDownloads: item.product.downloadLimit,
        },
      });
    }

    return { order, downloadToken };
  });

  const order = result.order;
  const item = order.items[0];
  const download = result.downloadToken ? `\nDownload securely: ${process.env.PUBLIC_API_URL || ""}/api/orders/download/${result.downloadToken}` : "";

  if (order.buyerEmail) await sendEmail(order.buyerId ?? undefined, order.buyerEmail, "UzaLink payment confirmed", `Your payment for ${item.product.name} was confirmed. Order ${order.publicId}.${download}`);
  if (order.buyerPhone) await sendSms(order.buyerId ?? undefined, order.buyerPhone, `UzaLink: payment confirmed for ${item.product.name}. Order ${order.publicId}.`);
  if (item.product.seller?.user?.email) await sendEmail(item.product.seller.user.id, item.product.seller.user.email, "UzaLink: new sale", `You received a sale for ${item.product.name}. Order ${order.publicId}. Seller net: KSh ${(item.sellerNetCents / 100).toLocaleString()}.`).catch(() => {});
  if (item.product.seller?.user?.phone) await sendSms(item.product.seller.user.id, item.product.seller.user.phone, `UzaLink: new sale for ${item.product.name}. Order ${order.publicId}.`).catch(() => {});
  return order;
}

async function issueDownloadInternal(grant: any, ipHash?: string, userAgent?: string, consume = true) {
  if (!grant) throw new Error("Download access is invalid");
  if (grant.order.status !== "PAID" && grant.order.status !== "FULFILLED") throw new Error("Payment not confirmed");
  if (grant.expiresAt.getTime() < Date.now()) throw new Error("Download access has expired. Please request a new download link.");
  if (!grant.product.privateFileKey) throw new Error("No private file is attached to this product");

  if (consume) {
    const claimed = await prisma.downloadGrant.updateMany({
      where: { id: grant.id, downloadCount: { lt: grant.maxDownloads }, expiresAt: { gt: new Date() } },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error(grant.downloadCount >= grant.maxDownloads ? "Download limit reached" : "Download access has expired. Please request a new download link.");
    await prisma.downloadEvent.create({ data: { grantId: grant.id, ipHash, userAgent } });
  }

  return signedDownloadUrl(grant.product.privateFileKey, grant.product.fileName || "download", 900);
}

export async function issueDownloadByGrantId(grantId: string, ipHash?: string, userAgent?: string) {
  const grant = await prisma.downloadGrant.findUnique({ where: { id: grantId }, include: { product: true, order: true } });
  return issueDownloadInternal(grant, ipHash, userAgent, false);
}

export async function issueDownload(grantToken: string, ipHash?: string, userAgent?: string) {
  const grant = await prisma.downloadGrant.findUnique({ where: { tokenHash: hashToken(grantToken) }, include: { product: true, order: true } });
  return issueDownloadInternal(grant, ipHash, userAgent, true);
}
