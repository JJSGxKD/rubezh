-- CreateEnum
CREATE TYPE "ExportSource" AS ENUM ('bot', 'cli');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('running', 'sent', 'failed');

-- CreateTable
CREATE TABLE "data_export" (
    "export_id" UUID NOT NULL,
    "source" "ExportSource" NOT NULL,
    "requested_by" VARCHAR(32) NOT NULL,
    "period_from" TIMESTAMPTZ(3),
    "period_to" TIMESTAMPTZ(3) NOT NULL,
    "status" "ExportStatus" NOT NULL,
    "events" INTEGER NOT NULL DEFAULT 0,
    "reports" INTEGER NOT NULL DEFAULT 0,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "parts" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "data_export_pkey" PRIMARY KEY ("export_id")
);

-- CreateIndex
CREATE INDEX "data_export_requested_by_created_at_idx" ON "data_export"("requested_by", "created_at");
