-- Батл-пасс (docs/35-stage4-plan.md Р46, §3.15, tasks/T-0311): очки пасса игрока за
-- месяц по Москве, ленты месяца из панели, журнал забранных наград и подарки-бусты.
-- Только добавление: существующие таблицы не меняются.
--
-- Формат держит сама база: ошибка в коде или в панели упрётся в `CHECK`, а не в
-- игрока. Ключ месяца — `ГГГГ-ММ`; лента — ровно 30 записей; ступень — 1…30;
-- лента забора — `free` или `vip`. Очки и подарки не уходят в минус.

-- CreateTable
CREATE TABLE "pass_progress" (
    "account_id" UUID NOT NULL,
    "month_key" VARCHAR(7) NOT NULL,
    "points" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pass_progress_pkey" PRIMARY KEY ("account_id","month_key")
);

-- CreateTable
CREATE TABLE "pass_season" (
    "month_key" VARCHAR(7) NOT NULL,
    "tiers" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pass_season_pkey" PRIMARY KEY ("month_key")
);

-- CreateTable
CREATE TABLE "pass_claim" (
    "account_id" UUID NOT NULL,
    "month_key" VARCHAR(7) NOT NULL,
    "tier" SMALLINT NOT NULL,
    "lane" VARCHAR(4) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pass_claim_pkey" PRIMARY KEY ("account_id","month_key","tier","lane")
);

-- CreateTable
CREATE TABLE "boost_credit" (
    "account_id" UUID NOT NULL,
    "boost_id" VARCHAR(32) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "boost_credit_pkey" PRIMARY KEY ("account_id","boost_id")
);

-- AddForeignKey
ALTER TABLE "pass_progress" ADD CONSTRAINT "pass_progress_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pass_claim" ADD CONSTRAINT "pass_claim_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boost_credit" ADD CONSTRAINT "boost_credit_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ограничения формата

ALTER TABLE "pass_progress" ADD CONSTRAINT "pass_progress_month_key_check" CHECK ("month_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "pass_progress" ADD CONSTRAINT "pass_progress_points_check" CHECK ("points" >= 0);

ALTER TABLE "pass_season" ADD CONSTRAINT "pass_season_month_key_check" CHECK ("month_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "pass_season" ADD CONSTRAINT "pass_season_tiers_check" CHECK (jsonb_typeof("tiers") = 'array' AND jsonb_array_length("tiers") = 30);

ALTER TABLE "pass_claim" ADD CONSTRAINT "pass_claim_month_key_check" CHECK ("month_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "pass_claim" ADD CONSTRAINT "pass_claim_tier_check" CHECK ("tier" BETWEEN 1 AND 30);
ALTER TABLE "pass_claim" ADD CONSTRAINT "pass_claim_lane_check" CHECK ("lane" IN ('free', 'vip'));

ALTER TABLE "boost_credit" ADD CONSTRAINT "boost_credit_count_check" CHECK ("count" >= 0);
