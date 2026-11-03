-- Пролог первого забега (T-0279, Р151): режим забега и признак «пролог пройден».

-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('endless', 'prologue');

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "prologue_done_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "mode" "RunMode" NOT NULL DEFAULT 'endless';

-- Старые игроки пролог не проходят: у кого есть хоть один забег, раздел «Награда дня» и «Задания» открыт сразу.
UPDATE "account" SET "prologue_done_at" = now() WHERE EXISTS (SELECT 1 FROM "run" WHERE "run"."account_id" = "account"."account_id");
