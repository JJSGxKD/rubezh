-- AdSonar закрыт 16.10.2026 (Р206): убираем выключенную строку справочника.
-- Блоки и показы сети не заводились; если они всё же есть, строку не
-- трогаем — история показов ссылается на сеть.
DELETE FROM "network_task" WHERE "network_key" = 'adsonar'
  AND NOT EXISTS (SELECT 1 FROM "ad_block" WHERE "network_key" = 'adsonar');
DELETE FROM "ad_network" WHERE "network_key" = 'adsonar'
  AND NOT EXISTS (SELECT 1 FROM "ad_block" WHERE "network_key" = 'adsonar');
