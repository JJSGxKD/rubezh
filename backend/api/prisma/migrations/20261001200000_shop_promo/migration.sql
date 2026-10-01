-- CreateTable
CREATE TABLE "shop_promo" (
    "promo_id" UUID NOT NULL,
    "sku" VARCHAR(32) NOT NULL,
    "percent" SMALLINT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "title" VARCHAR(48),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,

    CONSTRAINT "shop_promo_pkey" PRIMARY KEY ("promo_id")
);

-- CreateIndex
CREATE INDEX "shop_promo_sku_starts_at_idx" ON "shop_promo"("sku", "starts_at");

-- CreateIndex
CREATE INDEX "shop_promo_ends_at_idx" ON "shop_promo"("ends_at");

-- Пределы честной скидки (shop/shop-promo-rules.ts) держит и база: строка
-- в обход сервиса не заведёт ни «−100%», ни акцию, кончившуюся до начала.
ALTER TABLE "shop_promo" ADD CONSTRAINT "shop_promo_percent_check" CHECK ("percent" BETWEEN 5 AND 80);
ALTER TABLE "shop_promo" ADD CONSTRAINT "shop_promo_period_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "shop_promo" ADD CONSTRAINT "shop_promo_cancel_check" CHECK (("cancelled_at" IS NULL) = ("cancelled_by" IS NULL));
