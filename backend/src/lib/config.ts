import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(10000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  COOKIE_NAME: z.string().default("uzalink_session"),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PHONE: z.string().min(7).optional(),
  ADMIN_NAME: z.string().default("UzaLink Admin"),

  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),

  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_INITIATOR_NAME: z.string().optional(),
  MPESA_SECURITY_CREDENTIAL: z.string().optional(),
  MPESA_B2C_RESULT_URL: z.string().url().optional(),
  MPESA_B2C_TIMEOUT_URL: z.string().url().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_CALLBACK_URL: z.string().url().optional(),

  PREMIUM_PRICE_KES: z.coerce.number().default(1000),
  PREMIUM_DURATION_DAYS: z.coerce.number().default(30),

  /*
   * TEMPORARY PREMIUM TESTING GATE
   *
   * true  = Premium Magic Login can be tested without an existing
   *         Premium subscription.
   * false = normal Premium subscription validation is enforced.
   *
   * Default is true temporarily so testing works immediately.
   */
  PREMIUM_OPEN_GATE: z.coerce.boolean().default(true),

  /*
   * Temporary Premium testing verification code.
   * When PREMIUM_OPEN_GATE=true, this is the code accepted by
   * the Premium Magic Login flow.
   */
  PREMIUM_TEST_CODE: z.string().default("1234"),

  /*
   * Kept for compatibility with the previous Premium test setup.
   * It is no longer required to restrict the open gate to one number.
   */
  PREMIUM_TEST_PHONE: z.string().default("0729914983"),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().default("false"),

  SMS_WEBHOOK_URL: z.string().optional(),
  SMS_WEBHOOK_TOKEN: z.string().optional(),
});

export const env = envSchema.parse(process.env);
