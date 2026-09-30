import { env } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "./mpesa.js";

const base = env.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

async function accessToken() {
  if (!env.MPESA_CONSUMER_KEY || !env.MPESA_CONSUMER_SECRET) {
    throw new Error("M-Pesa consumer credentials are not configured");
  }

  const basic = Buffer.from(`${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await r.json().catch(() => ({})) as any;

  if (!r.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.errorMessage || "M-Pesa authentication failed");
  }

  return data.access_token as string;
}

export async function sendSellerPayout(payoutId: string) {
  if (!env.MPESA_INITIATOR_NAME || !env.MPESA_SECURITY_CREDENTIAL || !env.MPESA_B2C_RESULT_URL || !env.MPESA_B2C_TIMEOUT_URL || !env.MPESA_SHORTCODE) {
    throw new Error("M-Pesa B2C payout configuration is incomplete");
  }

  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: { seller: true },
  });

  if (!payout) throw new Error("Payout not found");
  if (payout.status === "PAID") throw new Error("This payout has already been paid");
  if (payout.status === "PROCESSING") throw new Error("This payout is already being processed by M-Pesa");

  const token = await accessToken();
  const phone = normalizePhone(payout.phone);
  const originatorConversationId = `UZL-${payout.id.slice(-8).toUpperCase()}`;

  /* Save the id before sending so a very fast Daraja callback can find the payout. */
  await prisma.payout.update({
    where: { id: payout.id },
    data: { status: "PROCESSING", phone, reference: originatorConversationId },
  });

  try {
    const r = await fetch(`${base}/mpesa/b2c/v3/paymentrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        OriginatorConversationID: originatorConversationId,
        InitiatorName: env.MPESA_INITIATOR_NAME,
        SecurityCredential: env.MPESA_SECURITY_CREDENTIAL,
        CommandID: "BusinessPayment",
        Amount: Math.round(payout.amountCents / 100),
        PartyA: env.MPESA_SHORTCODE,
        PartyB: phone,
        Remarks: "UzaLink seller payout",
        QueueTimeOutURL: env.MPESA_B2C_TIMEOUT_URL,
        ResultURL: env.MPESA_B2C_RESULT_URL,
        Occasion: "Seller payout",
      }),
    });

    const data = await r.json().catch(() => ({})) as any;

    if (!r.ok || data.ResponseCode !== "0") {
      const message = String(data?.errorMessage || data?.ResponseDescription || data?.errorDescription || "B2C payout request was rejected by M-Pesa");

      if (/duplicate originatorconversationid/i.test(message)) {
        return {
          accepted: true,
          alreadySubmitted: true,
          OriginatorConversationID: originatorConversationId,
          message: "This payout request was already submitted to M-Pesa and is awaiting its callback.",
        };
      }

      await prisma.payout.update({ where: { id: payout.id }, data: { status: "FAILED" } });
      throw new Error(message);
    }

    await prisma.payout.update({
      where: { id: payout.id },
      data: { status: "PROCESSING", reference: data.ConversationID || originatorConversationId },
    });

    return data;
  } catch (error) {
    const current = await prisma.payout.findUnique({ where: { id: payout.id }, select: { status: true } });
    if (current?.status === "PROCESSING") {
      await prisma.payout.update({ where: { id: payout.id }, data: { status: "FAILED" } }).catch(() => {});
    }
    throw error;
  }
}
