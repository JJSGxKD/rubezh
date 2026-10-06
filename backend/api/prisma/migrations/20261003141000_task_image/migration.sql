-- Картинка 1:1 партнёрского задания (docs/35-stage4-plan.md Р82, WP13,
-- часть 7): рядом с заданием у игрока — 44 px; нет — значок вида. Картинка
-- лежит в `media_image`, и пока задание на неё ссылается, удалить её нельзя.
ALTER TABLE "task_def" ADD COLUMN "image_id" VARCHAR(64);

ALTER TABLE "task_def" ADD CONSTRAINT "task_def_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "media_image"("image_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Картинка — только у партнёрской цели: у цели забега рядом с текстом её прогресс.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_image_kind_check" CHECK ("image_id" IS NULL OR "params" IS NOT NULL);
