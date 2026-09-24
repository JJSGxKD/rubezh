-- CreateEnum
CREATE TYPE "StartKind" AS ENUM ('organic', 'click', 'invite', 'telegram_affiliate', 'unknown');

-- CreateEnum
CREATE TYPE "SessionPlace" AS ENUM ('miniapp', 'web');

-- CreateEnum
CREATE TYPE "DeviceClass" AS ENUM ('mobile', 'desktop', 'web', 'unknown');

-- CreateTable
CREATE TABLE "account_session" (
    "session_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "place" "SessionPlace" NOT NULL,
    "start_kind" "StartKind" NOT NULL,
    "start_param" VARCHAR(64),
    "start_ref" VARCHAR(64),
    "client_platform" VARCHAR(16),
    "client_version" VARCHAR(16),
    "device_class" "DeviceClass" NOT NULL,
    "os" VARCHAR(16) NOT NULL,
    "ip_prefix" VARCHAR(64),
    "started_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_session_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "acquisition" (
    "account_id" UUID NOT NULL,
    "first_at" TIMESTAMPTZ(3) NOT NULL,
    "first_start_kind" "StartKind" NOT NULL,
    "first_start_param" VARCHAR(64),
    "first_start_ref" VARCHAR(64),
    "first_client_platform" VARCHAR(16),
    "first_device_class" "DeviceClass" NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_touch_at" TIMESTAMPTZ(3),
    "last_start_kind" "StartKind",
    "last_start_param" VARCHAR(64),
    "last_start_ref" VARCHAR(64),

    CONSTRAINT "acquisition_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "account_session_account_id_started_at_idx" ON "account_session"("account_id", "started_at");

-- CreateIndex
CREATE INDEX "account_session_started_at_idx" ON "account_session"("started_at");

-- CreateIndex
CREATE INDEX "account_session_start_kind_start_ref_idx" ON "account_session"("start_kind", "start_ref");

-- CreateIndex
CREATE INDEX "acquisition_first_start_kind_first_at_idx" ON "acquisition"("first_start_kind", "first_at");

-- AddForeignKey
ALTER TABLE "account_session" ADD CONSTRAINT "account_session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition" ADD CONSTRAINT "acquisition_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
