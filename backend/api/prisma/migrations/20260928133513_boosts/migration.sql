-- CreateTable
CREATE TABLE "run_boost" (
    "run_id" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "boosts" TEXT[],
    "cost" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "refunded_at" TIMESTAMPTZ(3),

    CONSTRAINT "run_boost_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "run_boost_account_id_created_at_idx" ON "run_boost"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "run_boost" ADD CONSTRAINT "run_boost_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Фоновый возврат ищет только невозвращённые покупки старше окна: частичный
-- индекс не растёт вместе с историей.
CREATE INDEX "run_boost_pending_idx" ON "run_boost"("created_at") WHERE "refunded_at" IS NULL;
