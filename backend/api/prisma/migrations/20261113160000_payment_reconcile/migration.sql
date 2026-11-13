-- CreateTable
CREATE TABLE "payment_reconcile_run" (
    "run_id" UUID NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "trigger" VARCHAR(16) NOT NULL,
    "actor_account_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "from_offset" INTEGER NOT NULL,
    "to_offset" INTEGER,
    "covered_from" TIMESTAMPTZ(3),
    "covered_to" TIMESTAMPTZ(3),
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "found" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(300),

    CONSTRAINT "payment_reconcile_run_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "payment_discrepancy" (
    "discrepancy_id" UUID NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "charge_id" VARCHAR(256) NOT NULL,
    "purchase_id" UUID,
    "account_id" UUID,
    "payer_id" VARCHAR(64),
    "amount" INTEGER NOT NULL,
    "payload" VARCHAR(128),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "run_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" VARCHAR(16),
    "resolved_by" UUID,
    "note" VARCHAR(200),

    CONSTRAINT "payment_discrepancy_pkey" PRIMARY KEY ("discrepancy_id")
);

-- CreateIndex
CREATE INDEX "payment_reconcile_run_platform_finished_at_idx" ON "payment_reconcile_run"("platform", "finished_at");

-- CreateIndex
CREATE INDEX "payment_discrepancy_resolved_at_detected_at_idx" ON "payment_discrepancy"("resolved_at", "detected_at");

-- CreateIndex
CREATE INDEX "payment_discrepancy_purchase_id_idx" ON "payment_discrepancy"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_discrepancy_platform_kind_charge_id_key" ON "payment_discrepancy"("platform", "kind", "charge_id");
