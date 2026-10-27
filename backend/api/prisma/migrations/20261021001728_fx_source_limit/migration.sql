-- CreateTable
CREATE TABLE "fx_source_limit" (
    "source" VARCHAR(32) NOT NULL,
    "per_month" INTEGER,
    "note" VARCHAR(200) NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_source_limit_pkey" PRIMARY KEY ("source")
);
