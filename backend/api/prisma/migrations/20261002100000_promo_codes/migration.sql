-- Промокоды (docs/35-stage4-plan.md WP41, docs/23-referral-and-partner-program.md §3):
-- кампания — то, что заводит команда в панели; код — то, что вводит игрок;
-- погашение — один игрок в одной кампании.

-- CreateTable
CREATE TABLE "promo_campaign" (
    "campaign_id" UUID NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "reward" JSONB NOT NULL,
    "message" VARCHAR(160),
    "max_redemptions" INTEGER,
    "redeemed" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "new_players_days" SMALLINT,
    "platforms" VARCHAR(16)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(16)[],
    "paused_at" TIMESTAMPTZ(3),
    "note" VARCHAR(200),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promo_campaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "promo_code" (
    "code" VARCHAR(32) NOT NULL,
    "display" VARCHAR(48) NOT NULL,
    "campaign_id" UUID NOT NULL,
    "redeemed_by" UUID,
    "redeemed_at" TIMESTAMPTZ(3),

    CONSTRAINT "promo_code_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "promo_redemption" (
    "campaign_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "redeemed_at" TIMESTAMPTZ(3) NOT NULL,
    "rewarded_at" TIMESTAMPTZ(3),
    "credited" JSONB,

    CONSTRAINT "promo_redemption_pkey" PRIMARY KEY ("campaign_id", "account_id")
);

-- CreateIndex
CREATE INDEX "promo_campaign_created_at_idx" ON "promo_campaign"("created_at");

-- CreateIndex
CREATE INDEX "promo_code_campaign_id_idx" ON "promo_code"("campaign_id");

-- CreateIndex
CREATE INDEX "promo_redemption_account_id_redeemed_at_idx" ON "promo_redemption"("account_id", "redeemed_at");

-- AddForeignKey
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promo_campaign"("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Кампанию с погашениями не удалить и мимо сервиса: по ней выданы награды.
-- AddForeignKey
ALTER TABLE "promo_redemption" ADD CONSTRAINT "promo_redemption_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promo_campaign"("campaign_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemption" ADD CONSTRAINT "promo_redemption_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Правила кампании (promo-codes/promo-code-rules.ts) держит и база: строка в
-- обход сервиса не заведёт ни пачку без числа кодов, ни погашений сверх лимита.
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_kind_check" CHECK ("kind" IN ('shared', 'batch'));
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_batch_limit_check" CHECK ("kind" = 'shared' OR "max_redemptions" IS NOT NULL);
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_redeemed_check" CHECK ("redeemed" >= 0 AND ("max_redemptions" IS NULL OR ("max_redemptions" > 0 AND "redeemed" <= "max_redemptions")));
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_period_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_new_players_check" CHECK ("new_players_days" IS NULL OR "new_players_days" BETWEEN 1 AND 90);
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_reward_check" CHECK (jsonb_typeof("reward") = 'object');
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_redeemed_check" CHECK (("redeemed_by" IS NULL) = ("redeemed_at" IS NULL));
