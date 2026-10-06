-- Публичные ключи сети (pubId, appId — ads/ad-networks.ts): их видно в коде
-- клиента, поэтому они в базе и правятся в панели. Секреты подтверждений —
-- только в окружении (Р53).
ALTER TABLE "ad_network" ADD COLUMN "keys" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ad_network" ADD CONSTRAINT "ad_network_keys_check" CHECK (jsonb_typeof("keys") = 'object');

-- Не у каждого формата есть блок в кабинете: RichAds и Taddy показывают по
-- ключам сети. Пустая строка вместо отсутствия запрещена — блок либо есть, либо нет.
ALTER TABLE "ad_block" ALTER COLUMN "external_id" DROP NOT NULL;
ALTER TABLE "ad_block" ADD CONSTRAINT "ad_block_external_id_check" CHECK ("external_id" IS NULL OR "external_id" <> '');
