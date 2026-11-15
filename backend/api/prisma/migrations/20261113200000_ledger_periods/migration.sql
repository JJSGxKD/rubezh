-- CreateEnum
CREATE TYPE "LedgerPeriodStatus" AS ENUM ('open', 'review', 'closed');

-- CreateTable
CREATE TABLE "ledger_period" (
    "period" CHAR(7) NOT NULL,
    "status" "LedgerPeriodStatus" NOT NULL DEFAULT 'open',
    "review_at" TIMESTAMPTZ(3),
    "review_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "reopened_count" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_period_pkey" PRIMARY KEY ("period")
);


-- Правила, которые схема Prisma не выражает: месяц — «ГГГГ-ММ»; закрытый месяц несёт время закрытия и снимок
-- (по ним он пересчитывается без базы); число снятий закрытия не отрицательно
ALTER TABLE "ledger_period" ADD CONSTRAINT "ledger_period_format_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "ledger_period" ADD CONSTRAINT "ledger_period_closed_check" CHECK ("status" <> 'closed' OR ("closed_at" IS NOT NULL AND "snapshot" IS NOT NULL));
ALTER TABLE "ledger_period" ADD CONSTRAINT "ledger_period_reopened_check" CHECK ("reopened_count" >= 0);
