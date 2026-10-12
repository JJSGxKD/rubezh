-- AlterTable
ALTER TABLE "account" ADD COLUMN     "tester_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "tester_compensation" (
    "account_id" UUID NOT NULL,
    "tester" BOOLEAN NOT NULL,
    "level" INTEGER NOT NULL,
    "bonus_gems" INTEGER NOT NULL,
    "grants" JSONB NOT NULL,
    "continue_stars" INTEGER NOT NULL,
    "snapshot_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),

    CONSTRAINT "tester_compensation_pkey" PRIMARY KEY ("account_id")
);

-- AddForeignKey
ALTER TABLE "tester_compensation" ADD CONSTRAINT "tester_compensation_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
