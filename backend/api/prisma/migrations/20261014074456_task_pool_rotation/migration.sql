-- AlterTable
ALTER TABLE "task_def" ADD COLUMN     "filter" JSONB,
ADD COLUMN     "tier" VARCHAR(8);

-- Ступень — только у дневных и недельных заданий: у достижений ротации нет.
-- Партнёрские цели от ступени отличает прикладной код (`taskDefSchema`).
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_tier_check" CHECK ("tier" IS NULL OR "tier" IN ('easy', 'medium', 'hard'));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_tier_period_check" CHECK ("tier" IS NULL OR "period"::text IN ('daily', 'weekly'));

-- Ступени старых строк: награды и цели у них не меняются.
UPDATE "task_def" SET "tier" = 'easy' WHERE "task_id" IN ('daily_runs', 'weekly_runs');
UPDATE "task_def" SET "tier" = 'medium' WHERE "task_id" IN ('daily_kills', 'daily_survive', 'weekly_kills', 'weekly_survive');
UPDATE "task_def" SET "tier" = 'hard' WHERE "task_id" = 'daily_level';

-- Пул ротации (docs/39-retention-mechanics.md П1, О-числа — старт, их
-- калибрует геймдизайнер): вместе со старыми семью строками — 20 дневных
-- (8 / 8 / 4) и 12 недельных (4 / 5 / 3). Текст задания строит клиент по виду
-- цели, поэтому `title` пуст. Награда по ступени: день 70 / 110 / 160 монет,
-- неделя 300 / 550 / 900 монет и 5 осколков у сложного.
INSERT INTO "task_def" ("task_id", "period", "kind", "target", "coins", "shards", "sort", "tier", "filter", "created_at", "updated_at") VALUES
  ('daily_best_120', 'daily', 'best_survival_sec', 120, 70, 0, 100, 'easy', NULL, now(), now()),
  ('daily_boost', 'daily', 'boost_runs', 1, 70, 0, 101, 'easy', NULL, now(), now()),
  ('daily_kills_300', 'daily', 'kills', 300, 70, 0, 102, 'easy', NULL, now(), now()),
  ('daily_level_10', 'daily', 'run_level', 10, 70, 0, 103, 'easy', NULL, now(), now()),
  ('daily_weapon_knife', 'daily', 'weapon_runs', 2, 70, 0, 104, 'easy', '{"weapon":"knife"}'::jsonb, now(), now()),
  ('daily_weapon_spark', 'daily', 'weapon_runs', 2, 70, 0, 105, 'easy', '{"weapon":"spark"}'::jsonb, now(), now()),
  ('daily_xp_500', 'daily', 'xp_collected', 500, 70, 0, 106, 'easy', NULL, now(), now()),
  ('daily_best_240', 'daily', 'best_survival_sec', 240, 110, 0, 200, 'medium', NULL, now(), now()),
  ('daily_element_cold', 'daily', 'element_runs', 2, 110, 0, 201, 'medium', '{"element":"cold"}'::jsonb, now(), now()),
  ('daily_element_fire', 'daily', 'element_runs', 2, 110, 0, 202, 'medium', '{"element":"fire"}'::jsonb, now(), now()),
  ('daily_hard_run', 'daily', 'difficulty_runs', 1, 110, 0, 203, 'medium', '{"difficulty":"hard"}'::jsonb, now(), now()),
  ('daily_normal_runs', 'daily', 'difficulty_runs', 2, 110, 0, 204, 'medium', '{"difficulty":"normal"}'::jsonb, now(), now()),
  ('daily_xp_1500', 'daily', 'xp_collected', 1500, 110, 0, 205, 'medium', NULL, now(), now()),
  ('daily_best_420', 'daily', 'best_survival_sec', 420, 160, 0, 300, 'hard', NULL, now(), now()),
  ('daily_hard_180', 'daily', 'difficulty_survive_sec', 180, 160, 0, 301, 'hard', '{"difficulty":"hard"}'::jsonb, now(), now()),
  ('daily_kills_3000', 'daily', 'kills', 3000, 160, 0, 302, 'hard', NULL, now(), now()),
  ('weekly_boost', 'weekly', 'boost_runs', 3, 300, 0, 100, 'easy', NULL, now(), now()),
  ('weekly_weapon_storm', 'weekly', 'weapon_runs', 5, 300, 0, 101, 'easy', '{"weapon":"storm"}'::jsonb, now(), now()),
  ('weekly_weapon_wardstone', 'weekly', 'weapon_runs', 5, 300, 0, 102, 'easy', '{"weapon":"wardstone"}'::jsonb, now(), now()),
  ('weekly_element_lightning', 'weekly', 'element_runs', 6, 550, 0, 200, 'medium', '{"element":"lightning"}'::jsonb, now(), now()),
  ('weekly_element_poison', 'weekly', 'element_runs', 6, 550, 0, 201, 'medium', '{"element":"poison"}'::jsonb, now(), now()),
  ('weekly_xp', 'weekly', 'xp_collected', 15000, 550, 0, 202, 'medium', NULL, now(), now()),
  ('weekly_best_540', 'weekly', 'best_survival_sec', 540, 900, 5, 300, 'hard', NULL, now(), now()),
  ('weekly_hard_240', 'weekly', 'difficulty_survive_sec', 240, 900, 5, 301, 'hard', '{"difficulty":"hard"}'::jsonb, now(), now()),
  ('weekly_level_30', 'weekly', 'run_level', 30, 900, 5, 302, 'hard', NULL, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
