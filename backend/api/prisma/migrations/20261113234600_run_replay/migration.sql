-- AlterTable
ALTER TABLE "run" ADD COLUMN     "replay_attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replay_diverged_tick" INTEGER,
ADD COLUMN     "replay_queued_at" TIMESTAMPTZ(3),
ADD COLUMN     "replay_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replay_result" JSONB,
ADD COLUMN     "replay_verdict" VARCHAR(16),
ADD COLUMN     "replayed_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "run_replay_verdict_finished_at_idx" ON "run"("replay_verdict", "finished_at");

