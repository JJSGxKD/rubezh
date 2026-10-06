-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('bound', 'activated', 'rejected');

-- CreateTable
CREATE TABLE "referral_binding" (
    "referred_account_id" UUID NOT NULL,
    "referrer_account_id" UUID NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'bound',
    "bound_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(32),

    CONSTRAINT "referral_binding_pkey" PRIMARY KEY ("referred_account_id")
);

-- CreateIndex
CREATE INDEX "referral_binding_referrer_account_id_activated_at_idx" ON "referral_binding"("referrer_account_id", "activated_at");

-- AddForeignKey
ALTER TABLE "referral_binding" ADD CONSTRAINT "referral_binding_referred_account_id_fkey" FOREIGN KEY ("referred_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_binding" ADD CONSTRAINT "referral_binding_referrer_account_id_fkey" FOREIGN KEY ("referrer_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Пригласить самого себя нельзя и на уровне базы.
ALTER TABLE "referral_binding" ADD CONSTRAINT "referral_binding_not_self" CHECK ("referred_account_id" <> "referrer_account_id");
