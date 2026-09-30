-- CreateEnum
CREATE TYPE "NotificationBotOutcome" AS ENUM ('sent', 'blocked', 'failed');

-- AlterEnum
ALTER TYPE "StartKind" ADD VALUE 'notification';

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "bot_at" TIMESTAMPTZ(3),
ADD COLUMN     "bot_outcome" "NotificationBotOutcome";
