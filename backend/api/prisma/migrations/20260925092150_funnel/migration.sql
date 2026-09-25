-- Вехи воронки аккаунта (docs/35-stage4-plan.md, Р30, §3.10).
-- CreateTable
CREATE TABLE "account_funnel" (
    "account_id" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ(3),
    "app_opened_at" TIMESTAMPTZ(3),
    "first_run_started_at" TIMESTAMPTZ(3),
    "first_run_finished_at" TIMESTAMPTZ(3),
    "runs_recorded" INTEGER NOT NULL DEFAULT 0,
    "runs_2_at" TIMESTAMPTZ(3),
    "runs_5_at" TIMESTAMPTZ(3),
    "returned_d1_at" TIMESTAMPTZ(3),
    "returned_d7_at" TIMESTAMPTZ(3),
    "first_purchase_at" TIMESTAMPTZ(3),

    CONSTRAINT "account_funnel_pkey" PRIMARY KEY ("account_id")
);

-- AddForeignKey
ALTER TABLE "account_funnel" ADD CONSTRAINT "account_funnel_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
