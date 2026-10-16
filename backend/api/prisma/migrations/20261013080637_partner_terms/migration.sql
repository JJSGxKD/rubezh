-- AlterTable
ALTER TABLE "partner" ADD COLUMN     "country" VARCHAR(2),
ADD COLUMN     "payout_currency" VARCHAR(8),
ADD COLUMN     "payout_method" VARCHAR(200),
ADD COLUMN     "share_percent" DECIMAL(5,2),
ADD COLUMN     "status" VARCHAR(16) NOT NULL DEFAULT 'active',
ADD COLUMN     "telegram_id" VARCHAR(20);

-- CreateIndex
CREATE UNIQUE INDEX "partner_telegram_id_key" ON "partner"("telegram_id");

-- CreateIndex
CREATE INDEX "partner_status_idx" ON "partner"("status");

