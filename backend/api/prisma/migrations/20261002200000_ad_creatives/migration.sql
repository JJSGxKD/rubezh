-- Креатив сети с API в сессии показа (docs/35-stage4-plan.md WP12, часть 9, Р78):
-- по его идентификатору сервер сообщает сети показ и досмотр, а досмотр
-- принимает не раньше срока от выдачи. Колонки пустые у показов SDK.

-- AlterTable
ALTER TABLE "ad_session" ADD COLUMN     "creative_id" VARCHAR(128),
ADD COLUMN     "view_sec" SMALLINT;
