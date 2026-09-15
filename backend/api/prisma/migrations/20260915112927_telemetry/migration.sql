-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('telegram', 'max', 'vk', 'web');

-- CreateEnum
CREATE TYPE "DiagnosticKind" AS ENUM ('bench', 'run');

-- CreateTable
CREATE TABLE "analytics_event" (
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "schema_version" SMALLINT NOT NULL,
    "install_id" VARCHAR(64) NOT NULL,
    "platform_user_id" VARCHAR(32),
    "session_id" VARCHAR(64) NOT NULL,
    "platform" "Platform" NOT NULL,
    "app_version" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "diagnostic_report" (
    "report_id" UUID NOT NULL,
    "kind" "DiagnosticKind" NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "app_version" VARCHAR(64) NOT NULL,
    "content_hash" VARCHAR(64),
    "install_id" VARCHAR(64) NOT NULL,
    "platform_user_id" VARCHAR(32),
    "platform" "Platform" NOT NULL,
    "device" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnostic_report_pkey" PRIMARY KEY ("report_id")
);

-- CreateIndex
CREATE INDEX "analytics_event_received_at_idx" ON "analytics_event"("received_at");

-- CreateIndex
CREATE INDEX "analytics_event_install_id_occurred_at_idx" ON "analytics_event"("install_id", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_event_event_type_received_at_idx" ON "analytics_event"("event_type", "received_at");

-- CreateIndex
CREATE INDEX "diagnostic_report_received_at_idx" ON "diagnostic_report"("received_at");

-- CreateIndex
CREATE INDEX "diagnostic_report_install_id_idx" ON "diagnostic_report"("install_id");

-- CreateIndex
CREATE INDEX "diagnostic_report_app_version_kind_idx" ON "diagnostic_report"("app_version", "kind");
