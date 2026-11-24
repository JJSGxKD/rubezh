-- VIP в подарок другу (docs/35-stage4-plan.md Р155, tasks/T-0249): вид покупки, подаренный срок
-- и заказ подарка. Новое значение перечисления в этой же миграции не используется: Postgres не
-- даёт применить его в той же транзакции, где оно добавлено.

-- AlterEnum
ALTER TYPE "PurchaseProduct" ADD VALUE 'vip_gift';

-- CreateTable
CREATE TABLE "vip_gift" (
    "purchase_id" UUID NOT NULL,
    "giver_account_id" UUID NOT NULL,
    "recipient_account_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vip_gift_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateTable
CREATE TABLE "vip_gift_order" (
    "purchase_id" UUID NOT NULL,
    "recipient_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vip_gift_order_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateIndex
CREATE INDEX "vip_gift_recipient_account_id_ends_at_idx" ON "vip_gift"("recipient_account_id", "ends_at");

-- AddForeignKey
ALTER TABLE "vip_gift" ADD CONSTRAINT "vip_gift_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_gift" ADD CONSTRAINT "vip_gift_giver_account_id_fkey" FOREIGN KEY ("giver_account_id") REFERENCES "account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_gift" ADD CONSTRAINT "vip_gift_recipient_account_id_fkey" FOREIGN KEY ("recipient_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_gift_order" ADD CONSTRAINT "vip_gift_order_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_gift_order" ADD CONSTRAINT "vip_gift_order_recipient_account_id_fkey" FOREIGN KEY ("recipient_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Срок подарка не нулевой, как и период подписки: конец позже начала.
ALTER TABLE "vip_gift" ADD CONSTRAINT "vip_gift_span_check" CHECK ("ends_at" > "starts_at");
