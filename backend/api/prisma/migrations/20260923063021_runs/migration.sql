-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('easy', 'normal', 'hard');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('started', 'finished');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('died', 'abandoned');

-- CreateEnum
CREATE TYPE "RunVerdict" AS ENUM ('ok', 'suspicious', 'rejected');

-- CreateTable
CREATE TABLE "run" (
    "run_id" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "RunStatus" NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "starting_weapon_id" VARCHAR(64) NOT NULL,
    "content_hash" VARCHAR(32) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "outcome" "RunOutcome",
    "survival_sec" DOUBLE PRECISION,
    "level" INTEGER,
    "enemies_killed" INTEGER,
    "weapons" JSONB,
    "death_cause" VARCHAR(64),
    "cheats" BOOLEAN NOT NULL DEFAULT false,
    "ranked" BOOLEAN NOT NULL DEFAULT false,
    "verdict" "RunVerdict",
    "verdict_reasons" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "run_account_id_finished_at_idx" ON "run"("account_id", "finished_at");

-- CreateIndex
CREATE INDEX "run_difficulty_ranked_survival_sec_idx" ON "run"("difficulty", "ranked", "survival_sec");

-- CreateIndex
CREATE INDEX "run_verdict_finished_at_idx" ON "run"("verdict", "finished_at");

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
