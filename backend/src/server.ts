import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import { env } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";

import { authRouter } from "./routes/auth.js";
import { productRouter } from "./routes/products.js";
import { orderRouter } from "./routes/orders.js";
import { sellerRouter } from "./routes/seller.js";
import { adminRouter } from "./routes/admin.js";
import { subscriptionRouter } from "./routes/subscriptions.js";
import { payoutRouter } from "./routes/payouts.js";

const app = express();

app.set("trust proxy", 1);

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://uzalink.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",

  ...(process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
];

console.log("[CORS] Allowed origins:", allowedOrigins);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests without an Origin header
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.replace(/\/$/, "");

    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    console.error("[CORS] Blocked origin:", origin);

    return callback(
      new Error(`CORS blocked origin: ${origin}`)
    );
  },

  credentials: true,

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  optionsSuccessStatus: 204,
};

app.use(helmet({\n  // Book covers are intentionally embedded by the Vercel frontend.\n  crossOriginResourcePolicy: { policy: "cross-origin" },\n}));

app.use(cors(corsOptions));

// Explicitly handle browser preflight requests

app.use(cookieParser());

app.use(
  express.json({
    limit: "2mb",
  })
);

/* =========================================================
   RATE LIMITING
========================================================= */

const apiLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", apiLimit);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "uzalink-api",
  });
});

/* =========================================================
   API ROUTES
========================================================= */

app.use("/api/auth", authRouter);

app.use("/api/products", productRouter);

app.use("/api/orders", orderRouter);

app.use("/api/seller", sellerRouter);

app.use("/api/admin", adminRouter);

app.use("/api/subscriptions", subscriptionRouter);

app.use("/api/payouts", payoutRouter);

/* =========================================================
   ERROR HANDLER
   TEMPORARY DIAGNOSTIC VERSION
========================================================= */

app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("========================================");
    console.error("[SERVER ERROR]");
    console.error("METHOD:", req.method);
    console.error("URL:", req.originalUrl);
    console.error("BODY:", req.body);
    console.error("ERROR:", err);
    console.error("MESSAGE:", err?.message);
    console.error("STACK:", err?.stack);
    console.error("========================================");

    res.status(err?.statusCode || 500).json({
      error: err?.message || "Server error",
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

const server = app.listen(env.PORT, () => {
  console.log(
    `UzaLink API listening on ${env.PORT}`
  );
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

const shutdown = async () => {
  console.log("Shutting down UzaLink API...");

  server.close();

  await prisma.$disconnect();

  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
