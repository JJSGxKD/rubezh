-- CreateTable
CREATE TABLE "friend_return" (
    "returned_account_id" UUID NOT NULL,
    "friend_account_id" UUID NOT NULL,
    "period" INTEGER NOT NULL,
    "returned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewarded_at" TIMESTAMPTZ(3),

    CONSTRAINT "friend_return_pkey" PRIMARY KEY ("returned_account_id","friend_account_id","period")
);

-- CreateIndex
CREATE INDEX "friend_return_returned_account_id_rewarded_at_idx" ON "friend_return"("returned_account_id", "rewarded_at");

-- AddForeignKey
ALTER TABLE "friend_return" ADD CONSTRAINT "friend_return_returned_account_id_fkey" FOREIGN KEY ("returned_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_return" ADD CONSTRAINT "friend_return_friend_account_id_fkey" FOREIGN KEY ("friend_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Вернуться «к самому себе» нельзя и на уровне базы.
ALTER TABLE "friend_return" ADD CONSTRAINT "friend_return_not_self" CHECK ("returned_account_id" <> "friend_account_id");
