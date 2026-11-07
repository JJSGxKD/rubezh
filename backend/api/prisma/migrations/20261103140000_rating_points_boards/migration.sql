-- CreateIndex
CREATE INDEX "run_difficulty_ranked_points_idx" ON "run"("difficulty", "ranked", "points");


-- Рейтинг по очкам (T-0294): недельные сезоны переходят на очки с понедельника
-- после выката, идущий сезон дотягивается по времени. Уже заданное в панели не
-- трогаем. date_trunc('week') — понедельник; прибавка недели даёт ближайший
-- понедельник строго после дня применения миграции.
INSERT INTO "app_setting" ("key", "value", "updated_at")
VALUES ('rating.points-from', to_jsonb(to_char(date_trunc('week', now() AT TIME ZONE 'UTC') + interval '7 days', 'YYYYMMDD')::int), now())
ON CONFLICT ("key") DO NOTHING;
