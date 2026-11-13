-- CreateEnum
CREATE TYPE "LedgerArticleKind" AS ENUM ('expense', 'income');

-- AlterTable
ALTER TABLE "ledger_account" ADD COLUMN     "article_id" VARCHAR(64),
ADD COLUMN     "fee_fixed" BIGINT,
ADD COLUMN     "fee_fixed_currency" VARCHAR(16),
ADD COLUMN     "fee_percent_bp" INTEGER,
ADD COLUMN     "place" VARCHAR(64);

-- CreateTable
CREATE TABLE "ledger_article" (
    "article_id" VARCHAR(64) NOT NULL,
    "kind" "LedgerArticleKind" NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "ledger_article_pkey" PRIMARY KEY ("article_id")
);

-- CreateIndex
CREATE INDEX "ledger_account_place_idx" ON "ledger_account"("place");

-- CreateIndex
CREATE INDEX "ledger_account_article_id_idx" ON "ledger_account"("article_id");

-- AddForeignKey
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "ledger_article"("article_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Шаблон комиссии: процент — сотые доли процента (0…10 000), фикса не отрицательна и всегда со своей валютой (Р220)
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_fee_percent_check" CHECK ("fee_percent_bp" IS NULL OR "fee_percent_bp" BETWEEN 0 AND 10000);
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_fee_fixed_check" CHECK (("fee_fixed" IS NULL) = ("fee_fixed_currency" IS NULL) AND ("fee_fixed" IS NULL OR "fee_fixed" >= 0));

-- Места на старте получают группу: звёзды бота — одно место в двух состояниях, остальные — каждое своё
UPDATE "ledger_account" SET "place" = 'stars.bot' WHERE "account_id" IN ('stars.bot.hold', 'stars.bot.available');
UPDATE "ledger_account" SET "place" = "account_id" WHERE "account_id" IN ('wallet.ton', 'exchange.usdt', 'bank.rub');

-- Статьи на старте (Р220); служебные нужны проводкам самого учёта, поэтому не архивируются. Время создания растёт
-- на миллисекунду, чтобы панель показывала статьи в этом порядке.
INSERT INTO "ledger_article" ("article_id", "kind", "name", "system", "created_at") VALUES
    ('vps', 'expense', 'Сервер (VPS)', false, CURRENT_TIMESTAMP + INTERVAL '1 millisecond'),
    ('cdn', 'expense', 'CDN Bunny', false, CURRENT_TIMESTAMP + INTERVAL '2 millisecond'),
    ('ai', 'expense', 'ИИ-инструменты', false, CURRENT_TIMESTAMP + INTERVAL '3 millisecond'),
    ('domains', 'expense', 'Домены', false, CURRENT_TIMESTAMP + INTERVAL '4 millisecond'),
    ('ads_purchase', 'expense', 'Закупка рекламы', false, CURRENT_TIMESTAMP + INTERVAL '5 millisecond'),
    ('fee_withdrawal', 'expense', 'Комиссия вывода', true, CURRENT_TIMESTAMP + INTERVAL '6 millisecond'),
    ('fee_exchange', 'expense', 'Комиссия обмена', true, CURRENT_TIMESTAMP + INTERVAL '7 millisecond'),
    ('fx_difference', 'expense', 'Курсовая разница', true, CURRENT_TIMESTAMP + INTERVAL '8 millisecond'),
    ('tax', 'expense', 'Налог (уплата)', true, CURRENT_TIMESTAMP + INTERVAL '9 millisecond'),
    ('other', 'expense', 'Прочее', false, CURRENT_TIMESTAMP + INTERVAL '10 millisecond'),
    ('ads_adsgram', 'income', 'Реклама: AdsGram', false, CURRENT_TIMESTAMP + INTERVAL '11 millisecond'),
    ('ads_richads', 'income', 'Реклама: RichAds', false, CURRENT_TIMESTAMP + INTERVAL '12 millisecond'),
    ('ads_taddy', 'income', 'Реклама: Taddy', false, CURRENT_TIMESTAMP + INTERVAL '13 millisecond'),
    ('other_income', 'income', 'Прочие поступления', false, CURRENT_TIMESTAMP + INTERVAL '14 millisecond');
