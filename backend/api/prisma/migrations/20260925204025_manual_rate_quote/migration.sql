-- Заданный курс — в валюте котировки (docs/35-stage4-plan.md, Р37): цена звезды
-- игроку — в рублях, выплата — в долларах. Переименование, а не пересоздание:
-- прежняя цена в долларах остаётся ценой с котировкой USD, и данные не теряются.
ALTER TABLE "fx_manual_rate" RENAME COLUMN "usd_per_unit" TO "price";
ALTER TABLE "fx_manual_rate" ADD COLUMN "quote" VARCHAR(8) NOT NULL DEFAULT 'USD';
