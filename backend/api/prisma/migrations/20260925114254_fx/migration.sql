-- Курсы валют: котировки, текущие и исторические курсы, заданные курсы,
-- снимки и бюджет источников (docs/35-stage4-plan.md, §3.12, WP9).
-- CreateTable
CREATE TABLE "fx_quote" (
    "source" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "usd_per_unit" DECIMAL(80,50) NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "saved_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_quote_pkey" PRIMARY KEY ("source","currency")
);

-- CreateTable
CREATE TABLE "fx_rate_current" (
    "currency" VARCHAR(8) NOT NULL,
    "usd_per_unit" DECIMAL(80,50) NOT NULL,
    "sources" VARCHAR(64)[],
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_rate_current_pkey" PRIMARY KEY ("currency")
);

-- CreateTable
CREATE TABLE "fx_rate_history" (
    "id" UUID NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "usd_per_unit" DECIMAL(80,50) NOT NULL,
    "sources" VARCHAR(64)[],
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_rate_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_manual_rate" (
    "id" UUID NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "usd_per_unit" DECIMAL(80,50) NOT NULL,
    "set_by" VARCHAR(64) NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "note" VARCHAR(200) NOT NULL,

    CONSTRAINT "fx_manual_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_snapshot" (
    "id" UUID NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL,
    "rates" JSONB NOT NULL,
    "payout" JSONB NOT NULL,

    CONSTRAINT "fx_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_source_state" (
    "source" VARCHAR(32) NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "used" INTEGER NOT NULL,
    "paused_until" TIMESTAMPTZ(3),
    "next_poll_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_source_state_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE INDEX "fx_rate_history_currency_accepted_at_idx" ON "fx_rate_history"("currency", "accepted_at");

-- CreateIndex
CREATE INDEX "fx_manual_rate_currency_purpose_set_at_idx" ON "fx_manual_rate"("currency", "purpose", "set_at");

-- CreateIndex
CREATE INDEX "fx_snapshot_taken_at_idx" ON "fx_snapshot"("taken_at");
