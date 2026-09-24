-- CreateEnum
CREATE TYPE "PurchaseProduct" AS ENUM ('continue_run');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('live', 'test');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('pending', 'paid', 'refunded');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('test_mode', 'unused', 'external');

-- CreateTable
CREATE TABLE "purchase" (
    "purchase_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "product" "PurchaseProduct" NOT NULL,
    "run_id" VARCHAR(64) NOT NULL,
    "continue_no" SMALLINT NOT NULL,
    "elapsed_sec" DOUBLE PRECISION NOT NULL,
    "price_stars" INTEGER NOT NULL,
    "charged_stars" INTEGER NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "status" "PurchaseStatus" NOT NULL,
    "telegram_charge_id" VARCHAR(128),
    "invoiced_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "refund_reason" "RefundReason",
    "refund_requested_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_telegram_charge_id_key" ON "purchase"("telegram_charge_id");

-- CreateIndex
CREATE INDEX "purchase_account_id_created_at_idx" ON "purchase"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_mode_paid_at_idx" ON "purchase"("mode", "paid_at");

-- CreateIndex
CREATE INDEX "purchase_refund_requested_at_idx" ON "purchase"("refund_requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_run_id_continue_no_key" ON "purchase"("run_id", "continue_no");

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;
