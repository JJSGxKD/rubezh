-- CreateEnum
CREATE TYPE "LedgerTemplateSchedule" AS ENUM ('monthly', 'yearly');

-- CreateTable
CREATE TABLE "ledger_template" (
    "template_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "article_id" VARCHAR(64) NOT NULL,
    "place_account_id" VARCHAR(64) NOT NULL,
    "amount" BIGINT NOT NULL,
    "schedule" "LedgerTemplateSchedule" NOT NULL,
    "month" SMALLINT,
    "note" VARCHAR(500),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "ledger_template_pkey" PRIMARY KEY ("template_id")
);

-- CreateIndex
CREATE INDEX "ledger_template_article_id_idx" ON "ledger_template"("article_id");

-- CreateIndex
CREATE INDEX "ledger_template_place_account_id_idx" ON "ledger_template"("place_account_id");

-- AddForeignKey
ALTER TABLE "ledger_template" ADD CONSTRAINT "ledger_template_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "ledger_article"("article_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_template" ADD CONSTRAINT "ledger_template_place_account_id_fkey" FOREIGN KEY ("place_account_id") REFERENCES "ledger_account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Правила, которые схема Prisma не выражает: месяц — только у годового шаблона и от 1 до 12; сумма больше нуля
ALTER TABLE "ledger_template" ADD CONSTRAINT "ledger_template_month_check" CHECK (("schedule" = 'yearly' AND "month" IS NOT NULL AND "month" BETWEEN 1 AND 12) OR ("schedule" = 'monthly' AND "month" IS NULL));
ALTER TABLE "ledger_template" ADD CONSTRAINT "ledger_template_amount_check" CHECK ("amount" > 0);
