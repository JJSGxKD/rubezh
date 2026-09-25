-- Уровень аккаунта и награды за забег (docs/35-stage4-plan.md, WP4).
-- CreateTable
CREATE TABLE "account_progress" (
    "account_id" UUID NOT NULL,
    "xp" BIGINT NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_progress_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "run_reward" (
    "run_id" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "coins" INTEGER NOT NULL,
    "coins_credited" INTEGER,
    "xp" INTEGER NOT NULL,
    "level_before" INTEGER NOT NULL,
    "level_after" INTEGER NOT NULL,
    "skipped" VARCHAR(32),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_reward_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "run_reward_account_id_created_at_idx" ON "run_reward"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "account_progress" ADD CONSTRAINT "account_progress_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_reward" ADD CONSTRAINT "run_reward_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
