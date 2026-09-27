-- Refund and fraud monitoring
DO $$ BEGIN
  CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED','APPROVED','PROCESSING','REFUNDED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "FraudStatus" AS ENUM ('OPEN','REVIEWED','CLEARED','BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Refund" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "adminNote" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Refund_orderId_status_idx" ON "Refund"("orderId","status");

CREATE TABLE IF NOT EXISTS "FraudFlag" (
  "id" TEXT NOT NULL,
  "orderId" TEXT,
  "userId" TEXT,
  "reason" TEXT NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "status" "FraudStatus" NOT NULL DEFAULT 'OPEN',
  "metadata" JSONB,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FraudFlag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FraudFlag_status_createdAt_idx" ON "FraudFlag"("status","createdAt");
CREATE INDEX IF NOT EXISTS "FraudFlag_orderId_idx" ON "FraudFlag"("orderId");

DO $$ BEGIN
  ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
