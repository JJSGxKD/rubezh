-- Самоцветы за ролик раз в игровые сутки (docs/35-stage4-plan.md Р155): место
-- показа free_gems и таблица взятых самоцветов. Одна строка на игрока и
-- игровые сутки, сессия показа уникальна и не тратится на два взятия.

-- AlterEnum
ALTER TYPE "AdPlace" ADD VALUE 'free_gems';

-- CreateTable
CREATE TABLE "free_gems_claim" (
    "account_id" UUID NOT NULL,
    "game_day" DATE NOT NULL,
    "session_id" VARCHAR(32) NOT NULL,
    "gems" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "free_gems_claim_pkey" PRIMARY KEY ("account_id","game_day")
);

-- CreateIndex
CREATE UNIQUE INDEX "free_gems_claim_session_id_key" ON "free_gems_claim"("session_id");

-- AddForeignKey
ALTER TABLE "free_gems_claim" ADD CONSTRAINT "free_gems_claim_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
