-- CreateTable
CREATE TABLE "stakeholder_share" (
    "share_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "from_month" DATE NOT NULL,
    "share_bp" INTEGER NOT NULL,
    "note" VARCHAR(500) NOT NULL,
    "set_by" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stakeholder_share_pkey" PRIMARY KEY ("share_id")
);

-- CreateIndex
CREATE INDEX "stakeholder_share_from_month_idx" ON "stakeholder_share"("from_month");

-- CreateIndex
CREATE UNIQUE INDEX "stakeholder_share_account_id_from_month_key" ON "stakeholder_share"("account_id", "from_month");

-- AddForeignKey
ALTER TABLE "stakeholder_share" ADD CONSTRAINT "stakeholder_share_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakeholder_share" ADD CONSTRAINT "stakeholder_share_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Доля — от 0 до 100 % в сотых долях процента; месяц начала — всегда первое число (Р217)
ALTER TABLE "stakeholder_share" ADD CONSTRAINT "stakeholder_share_share_bp_check" CHECK ("share_bp" BETWEEN 0 AND 10000);
ALTER TABLE "stakeholder_share" ADD CONSTRAINT "stakeholder_share_from_month_check" CHECK (extract(day from "from_month") = 1);

