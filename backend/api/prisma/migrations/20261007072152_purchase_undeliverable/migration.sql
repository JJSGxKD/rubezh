-- AlterEnum
ALTER TYPE "RefundReason" ADD VALUE 'undeliverable';

-- CreateIndex
CREATE INDEX "purchase_product_fulfilled_at_paid_at_idx" ON "purchase"("product", "fulfilled_at", "paid_at");
