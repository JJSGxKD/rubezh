-- CreateTable
CREATE TABLE "purchase_compensation" (
    "purchase_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "resource" VARCHAR(32) NOT NULL,
    "amount" INTEGER NOT NULL,
    "suggested" INTEGER,
    "note" VARCHAR(200) NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "credited_at" TIMESTAMPTZ(3),

    CONSTRAINT "purchase_compensation_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateIndex
CREATE INDEX "purchase_compensation_created_at_idx" ON "purchase_compensation"("created_at");

-- AddForeignKey
ALTER TABLE "purchase_compensation" ADD CONSTRAINT "purchase_compensation_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

