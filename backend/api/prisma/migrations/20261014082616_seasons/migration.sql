-- CreateTable
CREATE TABLE "season" (
    "season_key" VARCHAR(10) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "players" INTEGER NOT NULL,
    "rewarded" INTEGER NOT NULL,

    CONSTRAINT "season_pkey" PRIMARY KEY ("season_key")
);

-- CreateTable
CREATE TABLE "season_result" (
    "season_key" VARCHAR(10) NOT NULL,
    "account_id" UUID NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "best_sec" DOUBLE PRECISION NOT NULL,
    "place" INTEGER NOT NULL,
    "board_size" INTEGER NOT NULL,

    CONSTRAINT "season_result_pkey" PRIMARY KEY ("season_key","account_id","difficulty")
);

-- CreateTable
CREATE TABLE "season_reward" (
    "season_key" VARCHAR(10) NOT NULL,
    "account_id" UUID NOT NULL,
    "coins" INTEGER NOT NULL,
    "prestige" INTEGER NOT NULL,
    "difficulty" "Difficulty",
    "place" INTEGER,
    "kind" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),

    CONSTRAINT "season_reward_pkey" PRIMARY KEY ("season_key","account_id")
);

-- CreateIndex
CREATE INDEX "season_result_season_key_difficulty_place_idx" ON "season_result"("season_key", "difficulty", "place");

-- CreateIndex
CREATE INDEX "season_result_account_id_season_key_idx" ON "season_result"("account_id", "season_key");

-- CreateIndex
CREATE INDEX "season_reward_account_id_status_idx" ON "season_reward"("account_id", "status");

-- CreateIndex
CREATE INDEX "run_difficulty_finished_at_idx" ON "run"("difficulty", "finished_at");

-- AddForeignKey
ALTER TABLE "season_result" ADD CONSTRAINT "season_result_season_key_fkey" FOREIGN KEY ("season_key") REFERENCES "season"("season_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_result" ADD CONSTRAINT "season_result_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_reward" ADD CONSTRAINT "season_reward_season_key_fkey" FOREIGN KEY ("season_key") REFERENCES "season"("season_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_reward" ADD CONSTRAINT "season_reward_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Проверки в базе, а не только в коде: Prisma их не знает, и повреждённую
-- строку не пропустит ни ручной SQL, ни ошибка в сервисе.
ALTER TABLE "season_result" ADD CONSTRAINT "season_result_place_check" CHECK ("place" >= 1 AND "board_size" >= "place");

ALTER TABLE "season_reward" ADD CONSTRAINT "season_reward_amount_check" CHECK ("coins" >= 0 AND "prestige" >= 0);

ALTER TABLE "season_reward" ADD CONSTRAINT "season_reward_status_check" CHECK (
    ("status" = 'pending' AND "claimed_at" IS NULL) OR ("status" = 'claimed' AND "claimed_at" IS NOT NULL)
);

ALTER TABLE "season_reward" ADD CONSTRAINT "season_reward_kind_check" CHECK (
    ("kind" = 'place' AND "difficulty" IS NOT NULL AND "place" IS NOT NULL)
    OR ("kind" = 'threshold' AND "difficulty" IS NULL AND "place" IS NULL)
);
