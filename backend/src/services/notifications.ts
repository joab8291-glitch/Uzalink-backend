import nodemailer from "nodemailer";
import { env } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";

/**
 * Gmail / SMTP mailer
 *
 * For Gmail:
 * SMTP_HOST=smtp.gmail.com
 * SMTP_PORT=587
 * SMTP_USER=your@gmail.com
 * SMTP_PASS=Google App Password
 * MAIL_FROM=your@gmail.com
 *
 * Port 587 uses STARTTLS.
 * Port 465 uses secure TLS.
 */
const mailer = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER
        ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          }
        : undefined,
    })
  : null;

/**
 * Send Email
 */
export async function sendEmail(
  userId: string | undefined,
  to: string,
  subject: string,
  body: string
) {
  // Always create notification record first
  const n = await prisma.notification.create({
    data: {
      userId: userId || undefined,
      channel: "EMAIL",
      recipient: to,
      subject,
      body,
    },
  });

  /**
   * SMTP configuration checks
   */
  if (!mailer) {
    const errorMessage =
      "SMTP mailer is not configured. Check SMTP_HOST.";

    console.error("[SMTP] EMAIL FAILED");
    console.error(`[SMTP] ${errorMessage}`);

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    throw new Error(errorMessage);
  }

  if (!env.SMTP_USER) {
    const errorMessage =
      "SMTP_USER is missing.";

    console.error("[SMTP] EMAIL FAILED");
    console.error(`[SMTP] ${errorMessage}`);

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    throw new Error(errorMessage);
  }

  if (!env.SMTP_PASS) {
    const errorMessage =
      "SMTP_PASS is missing.";

    console.error("[SMTP] EMAIL FAILED");
    console.error(`[SMTP] ${errorMessage}`);

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    throw new Error(errorMessage);
  }

  if (!env.MAIL_FROM) {
    const errorMessage =
      "MAIL_FROM is missing.";

    console.error("[SMTP] EMAIL FAILED");
    console.error(`[SMTP] ${errorMessage}`);

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    throw new Error(errorMessage);
  }

  /**
   * Send email through SMTP
   */
  try {
    console.log("========================================");
    console.log("[SMTP] Sending email...");
    console.log("[SMTP] Host:", env.SMTP_HOST);
    console.log("[SMTP] Port:", env.SMTP_PORT);
    console.log("[SMTP] User:", env.SMTP_USER);
    console.log("[SMTP] From:", env.MAIL_FROM);
    console.log("[SMTP] To:", to);
    console.log("[SMTP] Subject:", subject);

    const info = await mailer.sendMail({
      from: env.MAIL_FROM,
      to,
      subject,
      text: body,
    });

    console.log("[SMTP] Email sent successfully");
    console.log("[SMTP] Message ID:", info.messageId);
    console.log("========================================");

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        sentAt: new Date(),
        error: null,
      },
    });

    return n;
  } catch (e) {
    const errorMessage =
      e instanceof Error
        ? e.message
        : "Email failed";

    console.error("========================================");
    console.error("[SMTP] EMAIL FAILED");
    console.error("[SMTP]", errorMessage);
    console.error("========================================");

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    // IMPORTANT:
    // Re-throw the error so the magic-link route
    // does not incorrectly return a successful email response.
    throw e;
  }
}

/**
 * Send SMS
 */
export async function sendSms(
  userId: string | undefined,
  to: string,
  body: string
) {
  const n = await prisma.notification.create({
    data: {
      userId: userId || undefined,
      channel: "SMS",
      recipient: to,
      body,
    },
  });

  if (!env.SMS_WEBHOOK_URL) {
    console.log(
      "[SMS] SMS webhook is not configured."
    );

    return n;
  }

  try {
    console.log("[SMS] Sending SMS to:", to);

    const r = await fetch(
      env.SMS_WEBHOOK_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",

          ...(env.SMS_WEBHOOK_TOKEN
            ? {
                Authorization:
                  `Bearer ${env.SMS_WEBHOOK_TOKEN}`,
              }
            : {}),
        },

        body: JSON.stringify({
          to,
          message: body,
        }),
      }
    );

    if (!r.ok) {
      throw new Error(
        `SMS provider returned ${r.status}`
      );
    }

    console.log(
      "[SMS] SMS sent successfully"
    );

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        sentAt: new Date(),
        error: null,
      },
    });
  } catch (e) {
    const errorMessage =
      e instanceof Error
        ? e.message
        : "SMS failed";

    console.error("[SMS] SMS FAILED");
    console.error("[SMS]", errorMessage);

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    // Keep existing SMS behavior:
    // record the failure but don't crash the request.
  }

  return n;
}
