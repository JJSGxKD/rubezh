-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'sending', 'paused', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('queued', 'sent', 'blocked', 'failed');

-- CreateTable
CREATE TABLE "broadcast" (
    "broadcast_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "platform" "Platform" NOT NULL,
    "text" VARCHAR(4096) NOT NULL,
    "button_text" VARCHAR(64),
    "link_code" VARCHAR(16),
    "button_url" VARCHAR(512),
    "segment" JSONB NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "audience" INTEGER,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "started_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "broadcast_pkey" PRIMARY KEY ("broadcast_id")
);

-- CreateTable
CREATE TABLE "broadcast_delivery" (
    "broadcast_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(32),
    "sent_at" TIMESTAMPTZ(3),
    "claimed_until" TIMESTAMPTZ(3),

    CONSTRAINT "broadcast_delivery_pkey" PRIMARY KEY ("broadcast_id","account_id")
);

-- CreateIndex
CREATE INDEX "broadcast_created_at_idx" ON "broadcast"("created_at");

-- CreateIndex
CREATE INDEX "broadcast_status_idx" ON "broadcast"("status");

-- CreateIndex
CREATE INDEX "broadcast_delivery_broadcast_id_status_idx" ON "broadcast_delivery"("broadcast_id", "status");

-- CreateIndex
CREATE INDEX "broadcast_delivery_account_id_sent_at_idx" ON "broadcast_delivery"("account_id", "sent_at");

-- AddForeignKey
ALTER TABLE "broadcast_delivery" ADD CONSTRAINT "broadcast_delivery_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcast"("broadcast_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_delivery" ADD CONSTRAINT "broadcast_delivery_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

