-- Можно ли писать игроку (docs/35-stage4-plan.md, §3.10).
-- CreateEnum
CREATE TYPE "MessagingReason" AS ENUM ('entered', 'write_access', 'blocked', 'unblocked');

-- CreateTable
CREATE TABLE "account_messaging" (
    "account_id" UUID NOT NULL,
    "can_message" BOOLEAN NOT NULL,
    "reason" "MessagingReason" NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_messaging_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "account_messaging_can_message_idx" ON "account_messaging"("can_message");

-- AddForeignKey
ALTER TABLE "account_messaging" ADD CONSTRAINT "account_messaging_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
