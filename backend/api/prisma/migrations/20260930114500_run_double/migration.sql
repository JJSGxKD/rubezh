-- AlterTable
ALTER TABLE "run_reward" ADD COLUMN "double_session_id" VARCHAR(32),
ADD COLUMN "doubled_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "run_reward_double_session_id_key" ON "run_reward"("double_session_id");

-- Удвоение начислено — только за сессию показа.
ALTER TABLE "run_reward" ADD CONSTRAINT "run_reward_doubled_check" CHECK ("doubled_at" IS NULL OR "double_session_id" IS NOT NULL);
