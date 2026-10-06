-- CreateEnum
CREATE TYPE "AdPlace" AS ENUM ('second_chance', 'wheel_spin', 'run_double', 'task', 'interstitial');

-- CreateEnum
CREATE TYPE "AdSuccess" AS ENUM ('view', 'click', 'cpa');

-- CreateEnum
CREATE TYPE "AdSessionStatus" AS ENUM ('pending', 'shown', 'completed', 'claimed', 'failed', 'expired');

-- CreateTable
CREATE TABLE "ad_network" (
    "network_key" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ad_network_pkey" PRIMARY KEY ("network_key")
);

-- CreateTable
CREATE TABLE "ad_block" (
    "block_id" UUID NOT NULL,
    "network_key" VARCHAR(32) NOT NULL,
    "place" "AdPlace" NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "success" "AdSuccess" NOT NULL DEFAULT 'view',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "platforms" "Platform"[] DEFAULT ARRAY[]::"Platform"[],
    "devices" VARCHAR(16)[] DEFAULT ARRAY[]::VARCHAR(16)[],
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "ad_block_pkey" PRIMARY KEY ("block_id")
);

-- CreateTable
CREATE TABLE "ad_session" (
    "session_id" VARCHAR(32) NOT NULL,
    "account_id" UUID NOT NULL,
    "place" "AdPlace" NOT NULL,
    "block_id" UUID NOT NULL,
    "network_key" VARCHAR(32) NOT NULL,
    "success" "AdSuccess" NOT NULL,
    "status" "AdSessionStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "shown_at" TIMESTAMPTZ(3),
    "clicked_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "claimed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "fail_reason" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ad_session_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE INDEX "ad_block_place_active_idx" ON "ad_block"("place", "active");

-- CreateIndex
CREATE INDEX "ad_session_account_id_place_created_at_idx" ON "ad_session"("account_id", "place", "created_at");

-- AddForeignKey
ALTER TABLE "ad_block" ADD CONSTRAINT "ad_block_network_key_fkey" FOREIGN KEY ("network_key") REFERENCES "ad_network"("network_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_session" ADD CONSTRAINT "ad_session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_session" ADD CONSTRAINT "ad_session_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "ad_block"("block_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Устройства блока — только известные; сессия истекает не раньше, чем
-- создана; забранная — только после выполнения условия успеха.
ALTER TABLE "ad_block" ADD CONSTRAINT "ad_block_devices_check" CHECK ("devices" <@ ARRAY['android', 'ios', 'desktop', 'web']::VARCHAR(16)[]);
ALTER TABLE "ad_session" ADD CONSTRAINT "ad_session_expires_check" CHECK ("expires_at" > "created_at");
ALTER TABLE "ad_session" ADD CONSTRAINT "ad_session_claim_check" CHECK ("claimed_at" IS NULL OR "completed_at" IS NOT NULL);

-- Сети, с которыми работаем (docs/35-stage4-plan.md WP12). Выключены, пока
-- их не одобрили и в панели не заведены блоки: без блоков место честно
-- отвечает «реклама сейчас недоступна».
INSERT INTO "ad_network" ("network_key", "name", "active", "priority", "updated_at") VALUES
  ('adsgram', 'AdsGram', false, 10, now()),
  ('adsonar', 'AdSonar', false, 20, now()),
  ('richads', 'RichAds', false, 30, now()),
  ('taddy', 'Taddy', false, 40, now());
