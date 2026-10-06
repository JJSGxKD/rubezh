-- CreateTable
CREATE TABLE "feature_flag" (
    "key" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "platforms" "Platform"[],
    "percent" INTEGER NOT NULL DEFAULT 100,
    "note" VARCHAR(200),
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("key")
);

-- Доля выката — проценты: база не даст записать 150 или −1 мимо проверки кода.
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_percent_range" CHECK ("percent" BETWEEN 0 AND 100);
