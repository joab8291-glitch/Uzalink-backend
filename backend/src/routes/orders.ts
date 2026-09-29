import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {
  createOrder,
  issueDownload,
  issueDownloadByGrantId,
  fulfillPaidOrder,
} from "../services/orders.js";
import { stkPush } from "../services/mpesa.js";
import { requireAuth } from "../middleware/auth.js";
import { hashToken } from "../lib/auth.js";
import { sendEmail, sendSms } from "../services/notifications.js";
import { inspectOrderRisk } from "../services/fraud.js";

function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("254")) return "0" + digits.slice(3);
  if (digits.startsWith("7") || digits.startsWith("1")) return "0" + digits;
  return digits;
}

export const orderRouter = Router();

/**
 * Create order
 */
orderRouter.post("/", async (req, res, next) => {
  try {
    const b = z
      .object({
        productId: z.string().optional(),
        productCode: z.string().optional(),
        name: z.string().min(2),
        phone: z.string(),
        email: z.string().email().optional(),
        address: z.string().max(500).optional(),
        couponCode: z.string().trim().min(3).max(32).optional(),
        referralCode: z.string().trim().min(3).max(64).optional(),
      })
      .parse(req.body);

    const product = b.productId
      ? await prisma.product.findUnique({
          where: { id: b.productId },
        })
      : b.productCode
      ? await prisma.product.findUnique({
          where: { code: b.productCode },
        })
      : null;

    if (!product) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    const o = await createOrder(
      product.id,
      {
        name: b.name,
        phone: b.phone,
        email: b.email,
        address: b.address,
      },
      req.user?.userId,
      b.couponCode,
      b.referralCode
    );

    await inspectOrderRisk(o.id).catch(() => null);
    res.status(201).json({ order: o });
  } catch (e) {
    next(e);
  }
});

/**
 * Initiate M-Pesa STK Push
 */
orderRouter.post("/:id/pay", async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: {
        id: req.params.id,
      },
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    if (order.status !== "PENDING") {
      return res.status(409).json({
        error: "Order is not payable",
      });
    }

    const existingPayment = await prisma.payment.findFirst({
      where: {
        orderId: order.id,
        status: "PENDING",
      },
      orderBy: { createdAt: "desc" },
    });

    if (existingPayment?.checkoutRequestId) {
      return res.json({
        orderId: order.id,
        publicId: order.publicId,
        checkoutRequestId: existingPayment.checkoutRequestId,
        message: "An M-Pesa payment request is already pending.",
      });
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        amountCents: order.amountCents,
        phone: order.buyerPhone,
      },
    });

    let mp;
    try {
      mp = await stkPush({
      phone: order.buyerPhone,
      amountCents: order.amountCents,
      accountReference: order.publicId,
      description: order.items[0].product.name,
      });
    } catch (error) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          resultDescription:
            error instanceof Error ? error.message : "M-Pesa STK request failed",
        },
      }).catch(() => {});
      throw error;
    }

    await prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        merchantRequestId: mp.MerchantRequestID,
        checkoutRequestId: mp.CheckoutRequestID,
      },
    });

    res.json({
      orderId: order.id,
      publicId: order.publicId,
      checkoutRequestId: mp.CheckoutRequestID,
      message: mp.CustomerMessage,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Get order
 */
orderRouter.get("/:id", async (req, res, next) => {
  try {
    const o = await prisma.order.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        publicId: true,
        status: true,
        items: {
          select: {
            product: {
              select: { code: true, name: true },
            },
          },
        },
        payments: {
          select: {
            status: true,
            resultDescription: true,
            resultCode: true,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!o) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ order: o });
  } catch (e) {
    next(e);
  }
});

/**
 * Get secure download access for a paid order.
 * The checkout phone number is verified before a short-lived signed URL is issued.
 */
orderRouter.post(
  "/:id/download-access",
  async (req, res, next) => {
    try {
      const body = z.object({ phone: z.string().min(7) }).parse(req.body);
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: {
          downloadGrants: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });

      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.buyerPhone !== body.phone) {
        return res.status(403).json({ error: "The phone number does not match this order" });
      }
      if (order.status !== "PAID" && order.status !== "FULFILLED") {
        return res.status(409).json({ error: "Payment has not been confirmed yet" });
      }

      const grant = order.downloadGrants[0];
      if (!grant) {
        return res.status(404).json({ error: "No digital download is available for this order" });
      }

      const ip = crypto.createHash("sha256").update(req.ip || "").digest("hex");
      const url = await issueDownloadByGrantId(
        grant.id,
        ip,
        req.get("user-agent")
      );

      res.json({ url, expiresInSeconds: 300 });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Secure digital-product download
 */
orderRouter.post(
  "/download/:token",
  async (req, res, next) => {
    try {
      const ip = crypto
        .createHash("sha256")
        .update(req.ip || "")
        .digest("hex");

      const url = await issueDownload(
        req.params.token,
        ip,
        req.get("user-agent")
      );

      res.json({
        url,
      });
    } catch (e) {
      next(e);
    }
  }
);

orderRouter.get(
  "/download/:token",
  async (req, res, next) => {
    try {
      const ip = crypto
        .createHash("sha256")
        .update(req.ip || "")
        .digest("hex");

      const url = await issueDownload(
        req.params.token,
        ip,
        req.get("user-agent")
      );

      res.redirect(url);
    } catch (e) {
      next(e);
    }
  }
);

/**
 * Safaricom Daraja STK callback
 *
 * PUBLIC ENDPOINT.
 * Safaricom calls this endpoint after the customer
 * completes or cancels the STK payment.
 */
orderRouter.post(
  "/mpesa/callback",
  async (req, res) => {
    try {
      const body = req.body?.Body?.stkCallback;

      const checkoutRequestId =
        body?.CheckoutRequestID;

      // Safaricom expects an acknowledgement.
      res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });

      if (!checkoutRequestId) {
        return;
      }

      const payment =
        await prisma.payment.findUnique({
          where: {
            checkoutRequestId,
          },
          include: {
            order: true,
          },
        });

      if (!payment) {
        console.warn(
          "M-Pesa callback received for unknown CheckoutRequestID:",
          checkoutRequestId
        );
        return;
      }

      /**
       * Payment already processed.
       * Prevent duplicate callbacks from crediting
       * the seller twice.
       */
      if (
        payment.status === "SUCCESS" ||
        payment.status === "FAILED"
      ) {
        return;
      }

      const resultCode = Number(
        body?.ResultCode
      );

      /**
       * Failed / cancelled STK payment
       */
      if (resultCode !== 0) {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: "FAILED",
            resultCode,
            resultDescription:
              body?.ResultDesc ||
              "M-Pesa payment failed",
            rawCallback: req.body,
          },
        });

        // Keep the order payable so the buyer can retry after a cancelled/failed STK push.\n        await prisma.order.update({ where: { id: payment.orderId }, data: { status: "PENDING" } });
        const failedOrder = await prisma.order.findUnique({ where: { id: payment.orderId }, include: { items: { include: { product: true } } } });
        if (failedOrder?.buyerEmail) await sendEmail(failedOrder.buyerId ?? undefined, failedOrder.buyerEmail, "UzaLink payment failed", `Payment for ${failedOrder.items[0]?.product.name || "your order"} was not completed. Order ${failedOrder.publicId}.`).catch(() => {});
        if (failedOrder?.buyerPhone) await sendSms(failedOrder.buyerId ?? undefined, failedOrder.buyerPhone, `UzaLink: payment failed for order ${failedOrder.publicId}. Please try again.`).catch(() => {});

        return;
      }

      /**
       * Successful payment metadata
       */
      const metadata =
        body?.CallbackMetadata?.Item || [];

      const getMetadata = (name: string) =>
        metadata.find(
          (item: any) => item.Name === name
        )?.Value;

      const receipt = String(
        getMetadata("MpesaReceiptNumber") || ""
      );

      const callbackAmountCents =
        Number(getMetadata("Amount") || 0) * 100;

      if (
        !Number.isFinite(callbackAmountCents) ||
        callbackAmountCents !== payment.amountCents
      ) {
        console.error("[M-Pesa] Callback amount mismatch", {
          paymentId: payment.id,
          orderId: payment.orderId,
          expectedAmountCents: payment.amountCents,
          callbackAmountCents,
        });
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: "FAILED",
            resultCode,
            resultDescription: "M-Pesa callback amount mismatch",
            rawCallback: req.body,
          },
        });
        return;
      }

      const callbackPhone = getMetadata("PhoneNumber");
      if (callbackPhone) {
        try {
          if (normalizePhone(String(callbackPhone)) !== normalizePhone(payment.phone)) {
            console.error("[M-Pesa] Callback phone mismatch", {
              paymentId: payment.id,
              orderId: payment.orderId,
            });
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: "FAILED",
                resultCode,
                resultDescription: "M-Pesa callback phone mismatch",
                rawCallback: req.body,
              },
            });
            return;
          }
        } catch {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: "FAILED",
              resultCode,
              resultDescription: "Invalid M-Pesa callback phone",
              rawCallback: req.body,
            },
          });
          return;
        }
      }

      if (receipt) {
        const duplicateReceipt = await prisma.payment.findFirst({
          where: {
            receipt,
            status: "SUCCESS",
            id: { not: payment.id },
          },
          select: { id: true },
        });
        if (duplicateReceipt) {
          console.error("[M-Pesa] Duplicate receipt rejected", {
            paymentId: payment.id,
            receipt,
          });
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: "FAILED",
              resultCode,
              resultDescription: "M-Pesa receipt already used",
              rawCallback: req.body,
            },
          });
          return;
        }
      }

      /**
       * Store successful callback details
       */
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          resultCode: 0,
          resultDescription:
            body?.ResultDesc ||
            "The service request is processed successfully.",
          rawCallback: req.body,
          receipt,
        },
      });

      /**
       * Premium subscription payment
       */
      const subscription =
        await prisma.subscription.findUnique({
          where: {
            paymentId: payment.id,
          },
        });

      if (
        subscription &&
        payment.amountCents !== subscription.priceCents
      ) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: "FAILED",
            resultDescription: "Premium payment amount mismatch",
          },
        });
        return;
      }

      if (subscription) {
        const starts = new Date();

        const durationDays = Number(
          process.env.PREMIUM_DURATION_DAYS || 30
        );

        const ends = new Date(
          starts.getTime() +
            durationDays *
              24 *
              60 *
              60 *
              1000
        );

        await prisma.subscription.update({
          where: {
            id: subscription.id,
          },
          data: {
            status: "ACTIVE",
            startsAt: starts,
            endsAt: ends,
          },
        });

        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: "SUCCESS",
            receipt,
          },
        });

        return;
      }

      /**
       * Normal marketplace order
       *
       * This:
       * - marks payment successful
       * - marks order PAID
       * - gives seller their 95%
       * - records the 5% commission
       * - updates sales count
       * - creates digital download grant
       * - creates physical delivery / booking
       * - sends notifications
       */
      await fulfillPaidOrder(
        payment.orderId,
        payment.id,
        receipt
      );
    } catch (error) {
      console.error(
        "M-Pesa callback processing error:",
        error
      );
    }
  }
);
