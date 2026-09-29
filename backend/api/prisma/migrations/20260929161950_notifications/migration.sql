-- CreateTable
CREATE TABLE "notification" (
    "notification_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("notification_id")
);

-- CreateIndex
CREATE INDEX "notification_account_id_created_at_idx" ON "notification"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_created_at_idx" ON "notification"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_account_id_dedupe_key_key" ON "notification"("account_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
