-- Кошелёк: журнал, балансы и суточные потолки (docs/35-stage4-plan.md, Р12, §3.2).
-- CreateEnum
CREATE TYPE "WalletResource" AS ENUM ('coins', 'gems', 'shard_common', 'shard_uncommon', 'shard_rare', 'shard_epic', 'shard_legendary', 'shard_mythic');

-- CreateTable
CREATE TABLE "wallet_entry" (
    "entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "resource" "WalletResource" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "source" VARCHAR(64),
    "idempotency_key" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_entry_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "wallet_balance" (
    "account_id" UUID NOT NULL,
    "resource" "WalletResource" NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_balance_pkey" PRIMARY KEY ("account_id","resource")
);

-- CreateTable
CREATE TABLE "wallet_daily" (
    "account_id" UUID NOT NULL,
    "resource" "WalletResource" NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "day" DATE NOT NULL,
    "granted" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "wallet_daily_pkey" PRIMARY KEY ("account_id","resource","reason","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_entry_idempotency_key_key" ON "wallet_entry"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_entry_account_id_created_at_idx" ON "wallet_entry"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "wallet_entry" ADD CONSTRAINT "wallet_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_balance" ADD CONSTRAINT "wallet_balance_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_daily" ADD CONSTRAINT "wallet_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Баланс — проекция журнала и отрицательным не бывает: проверка в базе, а не
-- только условием списания в коде. Prisma проверок не описывает, поэтому она
-- живёт в миграции.
ALTER TABLE "wallet_balance" ADD CONSTRAINT "wallet_balance_non_negative" CHECK ("balance" >= 0);
