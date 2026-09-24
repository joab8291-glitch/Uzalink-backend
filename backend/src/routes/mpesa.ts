import { env } from "../lib/config.js";

const base =
  env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const normalizePhone = (v: string) => {
  let p = v.replace(/[\s+\-]/g, "");

  if (p.startsWith("0")) {
    p = `254${p.slice(1)}`;
  }

  if (/^[17]\d{8}$/.test(p)) {
    p = `254${p}`;
  }

  if (!/^254[17]\d{8}$/.test(p)) {
    throw new Error("Invalid Kenyan M-Pesa phone number");
  }

  return p;
};

async function token() {
  if (
    !env.MPESA_CONSUMER_KEY ||
    !env.MPESA_CONSUMER_SECRET
  ) {
    throw new Error("M-Pesa credentials are not configured");
  }

  const basic = Buffer.from(
    `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const r = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${basic}`,
      },
    }
  );

  if (!r.ok) {
    throw new Error("Could not authenticate with M-Pesa");
  }

  return (
    await r.json() as {
      access_token: string;
    }
  ).access_token;
}

export async function stkPush(input: {
  phone: string;
  amountCents: number;
  accountReference: string;
  description: string;
}) {
  if (
    !env.MPESA_PASSKEY ||
    !env.MPESA_SHORTCODE ||
    !env.MPESA_CALLBACK_URL
  ) {
    throw new Error("M-Pesa STK configuration is incomplete");
  }

  const phone = normalizePhone(input.phone);
  const access = await token();

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);

  const password = Buffer.from(
    `${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`
  ).toString("base64");

  const r = await fetch(
    `${base}/mpesa/stkpush/v1/processrequest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.max(
          1,
          Math.round(input.amountCents / 100)
        ),
        PartyA: phone,
        PartyB: env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: env.MPESA_CALLBACK_URL,
        AccountReference: input.accountReference.slice(0, 12),
        TransactionDesc: input.description.slice(0, 20),
      }),
    }
  );

  const data = await r.json() as any;

  if (!r.ok || data.ResponseCode !== "0") {
    throw new Error(
      data.errorMessage ||
        data.ResponseDescription ||
        "M-Pesa STK Push failed"
    );
  }

  return {
    ...data,
    phone,
  };
}

export { normalizePhone };
