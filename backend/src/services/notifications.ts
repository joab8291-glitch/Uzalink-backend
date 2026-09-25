import { Resend } from "resend";
import { env } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";

/**
 * Resend Email API
 *
 * Required environment variables:
 *
 * RESEND_API_KEY=re_xxxxxxxxx
 * MAIL_FROM=onboarding@resend.dev
 *
 * For production, MAIL_FROM should normally use
 * an address on a domain verified in Resend.
 */

const resend = env.RESEND_API_KEY
  ? new Resend(env.RESEND_API_KEY)
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
   * Check Resend configuration
   */
  if (!resend) {
    const errorMessage =
      "Resend is not configured. RESEND_API_KEY is missing.";

    console.error("========================================");
    console.error("[EMAIL] EMAIL FAILED");
    console.error(`[EMAIL] ${errorMessage}`);
    console.error("========================================");

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

    console.error("========================================");
    console.error("[EMAIL] EMAIL FAILED");
    console.error(`[EMAIL] ${errorMessage}`);
    console.error("========================================");

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    throw new Error(errorMessage);
  }

  /**
   * Send through Resend API
   */
  try {
    console.log("========================================");
    console.log("[EMAIL] Sending email through Resend...");
    console.log("[EMAIL] From:", env.MAIL_FROM);
    console.log("[EMAIL] To:", to);
    console.log("[EMAIL] Subject:", subject);

    const { data, error } =
      await resend.emails.send({
        from: env.MAIL_FROM,
        to: [to],
        subject,
        text: body,
      });

    /**
     * Resend returned an error
     */
    if (error) {
      const errorMessage =
        error.message ||
        "Resend email sending failed.";

      console.error(
        "[EMAIL] Resend returned an error:"
      );
      console.error(
        "[EMAIL]",
        errorMessage
      );

      await prisma.notification.update({
        where: { id: n.id },
        data: {
          error: errorMessage,
        },
      });

      throw new Error(errorMessage);
    }

    /**
     * Successful email request
     */
    console.log(
      "[EMAIL] Email sent successfully."
    );

    console.log(
      "[EMAIL] Resend Message ID:",
      data?.id
    );

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
        : "Email sending failed.";

    console.error("========================================");
    console.error("[EMAIL] EMAIL FAILED");
    console.error("[EMAIL]", errorMessage);
    console.error("========================================");

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });

    /**
     * IMPORTANT:
     * Re-throw so /magic-link does not
     * falsely report a successful email.
     */
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
    console.log(
      "[SMS] Sending SMS to:",
      to
    );

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

    console.error(
      "[SMS] SMS FAILED"
    );

    console.error(
      "[SMS]",
      errorMessage
    );

    await prisma.notification.update({
      where: { id: n.id },
      data: {
        error: errorMessage,
      },
    });
  }

  return n;
}
