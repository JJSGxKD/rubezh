-- Прямая ссылка на Mini App для рекламы (tasks/T-0181, docs/35-stage4-plan.md
-- Р117, Р121): код ссылки и метки клика сети едут в стартовом параметре, а
-- запуск по такой ссылке становится конверсией без клика. Только расширения:
-- ничего не удаляется, код прошлого релиза на такой схеме работает.

-- Стартовый параметр Mini App (`startapp`) — до 512 знаков, `/start` бота
-- остаётся в 64. Увеличение предела varchar в Postgres не переписывает
-- таблицу: меняются только метаданные колонки, блокировка короткая.
ALTER TABLE "account_session" ALTER COLUMN "start_param" SET DATA TYPE VARCHAR(512);

ALTER TABLE "acquisition" ALTER COLUMN "first_start_param" SET DATA TYPE VARCHAR(512),
ALTER COLUMN "last_start_param" SET DATA TYPE VARCHAR(512);

-- У конверсии по прямому запуску клика нет, а метки сети лежат на самой строке.
ALTER TABLE "ad_conversion" ADD COLUMN     "network_params" JSONB,
ALTER COLUMN "click_id" DROP NOT NULL;

-- Регистрация, первая покупка и возврат без клика — по одной на аккаунт и
-- назначение. Ключ на клик (`ad_conversion_click_id_goal_destination_key`)
-- здесь не работает: пустые значения в уникальном индексе считаются разными.
-- Повторных покупок много, их держит ключ на оплату. Prisma частичные индексы
-- не описывает, поэтому индекс только здесь.
CREATE UNIQUE INDEX "ad_conversion_account_goal_destination_direct_key" ON "ad_conversion"("account_id", "goal", "destination") WHERE "click_id" IS NULL AND "goal" IN (1, 2, 4);

-- Метки обнуляются, когда окно конверсии закрыто, — отбор только среди непустых.
CREATE INDEX "ad_conversion_network_params_created_at_idx" ON "ad_conversion"("created_at") WHERE "network_params" IS NOT NULL;
