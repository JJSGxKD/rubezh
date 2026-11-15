-- Архив рекламных блоков (tasks/T-0409, docs/35-stage4-plan.md Р200).
-- Только расширение: колонка допускает NULL и без умолчания, прежний код её не читает, выкат по репликам безопасен.
--
-- ad_block.archived_at — момент, когда блок убрали «В архив»; NULL — блок не в архиве.
ALTER TABLE "ad_block" ADD COLUMN "archived_at" TIMESTAMPTZ(3);
