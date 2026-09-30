-- CreateEnum
CREATE TYPE "VipRenewal" AS ENUM ('on', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "VipCanceller" AS ENUM ('player', 'game');

-- CreateTable
CREATE TABLE "vip_subscription" (
    "subscription_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "renewal" "VipRenewal" NOT NULL DEFAULT 'on',
    "cancelled_by" "VipCanceller",
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vip_subscription_pkey" PRIMARY KEY ("subscription_id")
);

-- CreateTable
CREATE TABLE "vip_period" (
    "purchase_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vip_period_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateTable
CREATE TABLE "vip_daily" (
    "account_id" UUID NOT NULL,
    "last_day" DATE NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vip_daily_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "vip_subscription_account_id_created_at_idx" ON "vip_subscription"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "vip_period_account_id_ends_at_idx" ON "vip_period"("account_id", "ends_at");

-- CreateIndex
CREATE INDEX "vip_period_subscription_id_idx" ON "vip_period"("subscription_id");

-- AddForeignKey
ALTER TABLE "vip_subscription" ADD CONSTRAINT "vip_subscription_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_subscription" ADD CONSTRAINT "vip_subscription_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_period" ADD CONSTRAINT "vip_period_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_period" ADD CONSTRAINT "vip_period_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_period" ADD CONSTRAINT "vip_period_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "vip_subscription"("subscription_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_daily" ADD CONSTRAINT "vip_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Период не пустой, а «кто отменил» есть ровно у отменённого продления:
-- иначе кнопка «вернуть продление» решала бы по строке, которой не бывает.
ALTER TABLE "vip_period" ADD CONSTRAINT "vip_period_span_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "vip_subscription" ADD CONSTRAINT "vip_subscription_cancelled_check" CHECK (("renewal" = 'cancelled') = ("cancelled_by" IS NOT NULL));
