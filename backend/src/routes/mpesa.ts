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
    throw new Error(
      "M-Pesa consumer key or consumer secret is not configured"
    );
  }

  const basic = Buffer.from(
    `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  let response: Response;

  try {
    response = await fetch(
      `${base}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
        },
      }
    );
  } catch (error) {
    console.error("M-Pesa OAuth network error:", error);

    throw new Error(
      `Could not connect to M-Pesa OAuth endpoint (${base})`
    );
  }

  const raw = await response.text();

  let data: any = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    console.error("M-Pesa OAuth error:", {
      status: response.status,
      data,
    });

    throw new Error(
      data?.error_description ||
        data?.errorMessage ||
        data?.error ||
        `M-Pesa authentication failed (${response.status})`
    );
  }

  if (!data.access_token) {
    console.error("M-Pesa OAuth missing access token:", data);

    throw new Error(
      "M-Pesa authentication succeeded but no access token was returned"
    );
  }

  return data.access_token as string;
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
    throw new Error(
      "M-Pesa STK configuration is incomplete"
    );
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

  const payload = {
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
  };

  console.log("Starting M-Pesa STK Push:", {
    environment: env.MPESA_ENV,
    base,
    phone,
    amount: payload.Amount,
    shortcode: env.MPESA_SHORTCODE,
    callbackUrl: env.MPESA_CALLBACK_URL,
    accountReference: payload.AccountReference,
  });

  let response: Response;

  try {
    response = await fetch(
      `${base}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
  } catch (error) {
    console.error("M-Pesa STK network error:", error);

    throw new Error(
      `Could not connect to M-Pesa STK endpoint (${base})`
    );
  }

  const raw = await response.text();

  let data: any = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  console.log("M-Pesa STK response:", {
    status: response.status,
    data,
  });

  if (!response.ok) {
    throw new Error(
      data?.errorMessage ||
        data?.ResponseDescription ||
        data?.error_description ||
        data?.error ||
        `M-Pesa STK request failed (${response.status})`
    );
  }

  if (data.ResponseCode !== "0") {
    throw new Error(
      data?.errorMessage ||
        data?.ResponseDescription ||
        data?.CustomerMessage ||
        "M-Pesa STK Push was rejected"
    );
  }

  if (!data.CheckoutRequestID) {
    console.error(
      "M-Pesa returned success but no CheckoutRequestID:",
      data
    );

    throw new Error(
      "M-Pesa accepted the request but did not return a CheckoutRequestID"
    );
  }

  return {
    ...data,
    phone,
  };
}

export { normalizePhone };
