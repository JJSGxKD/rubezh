-- Единая сложность (Р126): рейтинг и сезоны считают забеги с даты применения
-- миграции на этой среде, то есть с выката. Уже заданное в панели не трогаем.
INSERT INTO "app_setting" ("key", "value", "updated_at")
VALUES ('rating.since-date', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD')::int), now())
ON CONFLICT ("key") DO NOTHING;

-- Задания пула с фильтром easy/normal: после перехода выбор сложности
-- исчез, а «сыграй на hard» не отличается от «сыграй забег». Строки
-- выключены, не удалены: панель может вернуть или убрать.
UPDATE "task_def" SET "active" = false, "updated_at" = now()
WHERE "kind" IN ('difficulty_runs', 'difficulty_survive_sec')
  AND "filter" ->> 'difficulty' IN ('easy', 'normal')
  AND "active";
