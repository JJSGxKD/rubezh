-- CreateEnum
CREATE TYPE "LedgerConfirmationStatus" AS ENUM ('confirmed', 'disputed');

-- AlterEnum
ALTER TYPE "LedgerOperationKind" ADD VALUE 'payout';

-- AlterTable
ALTER TABLE "ledger_operation" ADD COLUMN     "override_reason" VARCHAR(500),
ADD COLUMN     "payee" VARCHAR(96),
ADD COLUMN     "payout_period" CHAR(7);

-- CreateTable
CREATE TABLE "ledger_confirmation" (
    "period" CHAR(7) NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "LedgerConfirmationStatus" NOT NULL,
    "comment" VARCHAR(1000),
    "decided_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_confirmation_pkey" PRIMARY KEY ("period","account_id")
);

-- CreateIndex
CREATE INDEX "ledger_operation_payout_period_idx" ON "ledger_operation"("payout_period");


-- Правила, которые схема Prisma не выражает: месяц — «ГГГГ-ММ»; спор несёт комментарий от трёх знаков, у любого решения
-- он не длиннее тысячи; выплата несёт получателя и месяц парой, причина решения владельца бывает только у выплаты
-- (после `ALTER TYPE … ADD VALUE` новое значение в этой же транзакции не используется: проверки на него не ссылаются)
ALTER TABLE "ledger_confirmation" ADD CONSTRAINT "ledger_confirmation_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "ledger_confirmation" ADD CONSTRAINT "ledger_confirmation_comment_check" CHECK (("comment" IS NULL OR char_length("comment") <= 1000) AND ("status" <> 'disputed' OR ("comment" IS NOT NULL AND char_length(btrim("comment")) >= 3)));
ALTER TABLE "ledger_operation" ADD CONSTRAINT "ledger_operation_payout_check" CHECK (("payee" IS NULL) = ("payout_period" IS NULL) AND ("payout_period" IS NULL OR "payout_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AND ("override_reason" IS NULL OR "payee" IS NOT NULL));
