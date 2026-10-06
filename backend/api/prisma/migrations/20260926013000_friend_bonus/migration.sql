-- CreateTable
CREATE TABLE "friend_bonus" (
    "account_id" UUID NOT NULL,
    "friends" INTEGER NOT NULL,
    "coins" INTEGER NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_bonus_pkey" PRIMARY KEY ("account_id","friends")
);

-- AddForeignKey
ALTER TABLE "friend_bonus" ADD CONSTRAINT "friend_bonus_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

