-- CreateEnum
CREATE TYPE "LedgerOperationKind" AS ENUM ('transfer', 'exchange', 'expense', 'income', 'loan', 'reversal');

-- CreateEnum
CREATE TYPE "LedgerOperationStatus" AS ENUM ('draft', 'pending', 'posted', 'rejected');

-- CreateTable
CREATE TABLE "ledger_operation" (
    "operation_id" UUID NOT NULL,
    "kind" "LedgerOperationKind" NOT NULL,
    "status" "LedgerOperationStatus" NOT NULL DEFAULT 'draft',
    "input" JSONB NOT NULL,
    "note" VARCHAR(500) NOT NULL,
    "link" VARCHAR(500),
    "amount_usd" DECIMAL(18,2),
    "source_key" VARCHAR(128),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(500),
    "template_id" VARCHAR(64),
    "template_period" CHAR(7),

    CONSTRAINT "ledger_operation_pkey" PRIMARY KEY ("operation_id")
);

-- CreateTable
CREATE TABLE "ledger_loan" (
    "loan_id" UUID NOT NULL,
    "lender" VARCHAR(128) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "principal" BIGINT NOT NULL,
    "premium" BIGINT NOT NULL,
    "repayment_bp" INTEGER NOT NULL,
    "operation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_loan_pkey" PRIMARY KEY ("loan_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_operation_source_key_key" ON "ledger_operation"("source_key");

-- CreateIndex
CREATE INDEX "ledger_operation_status_created_at_idx" ON "ledger_operation"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_operation_template_id_template_period_key" ON "ledger_operation"("template_id", "template_period");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_loan_operation_id_key" ON "ledger_loan"("operation_id");

-- CreateIndex
CREATE INDEX "ledger_loan_account_id_idx" ON "ledger_loan"("account_id");

-- AddForeignKey
ALTER TABLE "ledger_loan" ADD CONSTRAINT "ledger_loan_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_loan" ADD CONSTRAINT "ledger_loan_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "ledger_operation"("operation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Правила, которые схема Prisma не выражает: период шаблона — «ГГГГ-ММ» и всегда в паре с шаблоном; проведённая
-- операция несёт ключ проводки; оценка в долларах не отрицательна
ALTER TABLE "ledger_operation" ADD CONSTRAINT "ledger_operation_template_check" CHECK (("template_id" IS NULL) = ("template_period" IS NULL) AND ("template_period" IS NULL OR "template_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'));
ALTER TABLE "ledger_operation" ADD CONSTRAINT "ledger_operation_posted_check" CHECK ("status" <> 'posted' OR "source_key" IS NOT NULL);
ALTER TABLE "ledger_operation" ADD CONSTRAINT "ledger_operation_amount_usd_check" CHECK ("amount_usd" IS NULL OR "amount_usd" >= 0);

-- Заём: тело больше нуля, премия не отрицательна, ставка погашения — доля чистой прибыли от 0 до 100 %
ALTER TABLE "ledger_loan" ADD CONSTRAINT "ledger_loan_amounts_check" CHECK ("principal" > 0 AND "premium" >= 0);
ALTER TABLE "ledger_loan" ADD CONSTRAINT "ledger_loan_repayment_check" CHECK ("repayment_bp" BETWEEN 0 AND 10000);

