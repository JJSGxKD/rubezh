-- Награда дня ×2 за ролик (docs/35-stage4-plan.md Р155): место показа
-- daily_double и таблица удвоений. Одна строка на игрока и игровые сутки,
-- сессия показа уникальна и не тратится на два удвоения.

-- AlterEnum
ALTER TYPE "AdPlace" ADD VALUE 'daily_double';

-- CreateTable
CREATE TABLE "daily_double" (
    "account_id" UUID NOT NULL,
    "game_day" DATE NOT NULL,
    "day_number" INTEGER NOT NULL,
    "session_id" VARCHAR(32) NOT NULL,
    "coins" INTEGER NOT NULL,
    "shards" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_double_pkey" PRIMARY KEY ("account_id","game_day")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_double_session_id_key" ON "daily_double"("session_id");

-- AddForeignKey
ALTER TABLE "daily_double" ADD CONSTRAINT "daily_double_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

