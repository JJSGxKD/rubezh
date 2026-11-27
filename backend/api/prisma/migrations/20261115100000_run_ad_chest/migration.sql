-- Второй сундук клада за рекламу (docs/35-stage4-plan.md Р162): место показа
-- clad_chest и книга показов. Второй сундук один на забег — run_id первичный
-- ключ, а сессия показа уникальна и не тратится на два забега.

-- AlterEnum
ALTER TYPE "AdPlace" ADD VALUE 'clad_chest';

-- CreateTable
CREATE TABLE "run_ad_chest" (
    "run_id" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "session_id" VARCHAR(32) NOT NULL,
    "network_key" VARCHAR(32) NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_ad_chest_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_ad_chest_session_id_key" ON "run_ad_chest"("session_id");

-- CreateIndex
CREATE INDEX "run_ad_chest_account_id_idx" ON "run_ad_chest"("account_id");

-- AddForeignKey
ALTER TABLE "run_ad_chest" ADD CONSTRAINT "run_ad_chest_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_ad_chest" ADD CONSTRAINT "run_ad_chest_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

