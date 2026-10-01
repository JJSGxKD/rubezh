-- AlterTable
ALTER TABLE "ad_session" ALTER COLUMN "block_id" DROP NOT NULL;

-- Сессия без блока — пропуск рекламы (VIP, §3.6): ролика нет, поэтому она
-- выполнена с момента выдачи и считается досмотренным показом.
ALTER TABLE "ad_session" ADD CONSTRAINT "ad_session_pass_check" CHECK ("block_id" IS NOT NULL OR ("success" = 'view' AND "completed_at" IS NOT NULL));
