-- CreateTable
CREATE TABLE "daily_reward" (
    "account_id" UUID NOT NULL,
    "claimed_days" INTEGER NOT NULL,
    "last_claim_day" DATE NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_reward_pkey" PRIMARY KEY ("account_id")
);

-- AddForeignKey
ALTER TABLE "daily_reward" ADD CONSTRAINT "daily_reward_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
