-- Слой «событие → назначение» постбэков (tasks/T-0069, docs/35-stage4-plan.md
-- Р86, Р96, WP43): строка конверсии — одно событие для одного назначения.
-- Фаза expand: колонки не удаляются, `goal` остаётся кодом события (1–3 как
-- `goaltype` AdsGram, 4 — возврат на следующий день), `network` хранит имя
-- назначения. Код прошлого релиза на такой схеме работает: строка, которую он
-- пишет без `destination`, получает `adsgram`.
ALTER TABLE "ad_conversion"
  ADD COLUMN "destination" VARCHAR(16) NOT NULL DEFAULT 'adsgram',
  ADD CONSTRAINT "ad_conversion_destination_check" CHECK ("destination" IN ('adsgram', 's2s', 'partner'));

-- Цель 4 допустима; оплата — у целей 2 и 3, у остальных её нет.
ALTER TABLE "ad_conversion" DROP CONSTRAINT "ad_conversion_goal_check", DROP CONSTRAINT "ad_conversion_purchase_check";
ALTER TABLE "ad_conversion"
  ADD CONSTRAINT "ad_conversion_goal_check" CHECK ("goal" BETWEEN 1 AND 4),
  ADD CONSTRAINT "ad_conversion_purchase_check" CHECK (("goal" IN (2, 3)) = ("purchase_id" IS NOT NULL));

-- Ключи теперь на назначение: одна оплата — одна строка на назначение.
DROP INDEX "ad_conversion_purchase_id_key";
DROP INDEX "ad_conversion_click_id_goal_key";

CREATE UNIQUE INDEX "ad_conversion_purchase_id_destination_key" ON "ad_conversion"("purchase_id", "destination");

-- Регистрация, первая покупка и возврат на следующий день — по одной на клик и
-- назначение: повторный проход не отправит их дважды. Повторных покупок на клик
-- много, их держит ключ на оплату.
CREATE UNIQUE INDEX "ad_conversion_click_id_goal_destination_key" ON "ad_conversion"("click_id", "goal", "destination") WHERE "goal" IN (1, 2, 4);
