-- AlterEnum
ALTER TYPE "PurchaseProduct" ADD VALUE 'shop_item';

-- AlterTable
ALTER TABLE "purchase" ADD COLUMN "fulfilled_at" TIMESTAMPTZ(3),
ADD COLUMN "once_key" VARCHAR(96),
ADD COLUMN "sku" VARCHAR(48),
ALTER COLUMN "run_id" DROP NOT NULL,
ALTER COLUMN "continue_no" DROP NOT NULL,
ALTER COLUMN "elapsed_sec" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "purchase_once_key_key" ON "purchase"("once_key");

-- Второй шанс — всегда с забегом, номером продолжения и секундой цены и без
-- товара каталога; остальное — с товаром каталога. Новое значение
-- перечисления в той же транзакции использовать нельзя, поэтому проверки
-- говорят только о прежнем.
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_continue_check" CHECK (
  ("product" = 'continue_run') = ("run_id" IS NOT NULL AND "continue_no" IS NOT NULL AND "elapsed_sec" IS NOT NULL)
);
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_sku_check" CHECK (("product" = 'continue_run') = ("sku" IS NULL));
