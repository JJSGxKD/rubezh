-- CreateTable
CREATE TABLE "friend_gift" (
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(3),

    CONSTRAINT "friend_gift_pkey" PRIMARY KEY ("from_account_id","to_account_id","day")
);

-- CreateIndex
CREATE INDEX "friend_gift_to_account_id_claimed_at_idx" ON "friend_gift"("to_account_id", "claimed_at");

-- AddForeignKey
ALTER TABLE "friend_gift" ADD CONSTRAINT "friend_gift_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_gift" ADD CONSTRAINT "friend_gift_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

