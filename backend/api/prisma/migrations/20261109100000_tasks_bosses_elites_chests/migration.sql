-- Задания и достижения про боссов, элит, сундуки, кристаллы и эволюции
-- (docs/39-retention-mechanics.md П1, К1, docs/35-stage4-plan.md Р102,
-- tasks/T-0126). Только добавление строк в `task_def`: колонок, таблиц и
-- существующих строк миграция не трогает. Пять видов цели — `boss_kills`,
-- `elite_kills`, `chests_opened`, `crystals_collected`, `evolution_runs` —
-- считает код сервера по итогу забега; здесь — стартовый набор строк, цели и
-- награды геймдизайнер калибрует из панели.

-- Пул ротации: 15 заданий (день +8, неделя +7). Пул дня после миграции — 28 строк
-- (11 / 11 / 6 по ступеням), недели — 19 (6 / 8 / 5); квоты ротации прежние.
-- Награда по ступени, как у остального пула: день 70 / 110 / 160 монет, неделя
-- 300 / 550 / 900 монет и у сложного ещё 5 осколков. Очки заданий берутся у
-- опорной строки той же ступени и срока, своих чисел нет. Текст строит клиент
-- по виду цели, поэтому `title` и `filter` пусты. `sort`: лёгкие с 150, средние
-- с 250, сложные с 350, внутри ступени по алфавиту id.
INSERT INTO "task_def" ("task_id", "period", "kind", "target", "coins", "shards", "pass_points", "sort", "tier", "created_at", "updated_at")
SELECT v."task_id", v."period"::"TaskPeriod", v."kind", v."target", v."coins", v."shards", a."pass_points", v."sort", v."tier", now(), now()
FROM (VALUES
  ('daily_chest_1',        'daily',  'chests_opened',      1,    70,  0, 150, 'easy',   'daily_runs'),
  ('daily_crystals_300',   'daily',  'crystals_collected', 300,  70,  0, 151, 'easy',   'daily_runs'),
  ('daily_elite_1',        'daily',  'elite_kills',        1,    70,  0, 152, 'easy',   'daily_runs'),
  ('daily_chest_3',        'daily',  'chests_opened',      3,    110, 0, 250, 'medium', 'daily_kills'),
  ('daily_crystals_1000',  'daily',  'crystals_collected', 1000, 110, 0, 251, 'medium', 'daily_kills'),
  ('daily_elite_3',        'daily',  'elite_kills',        3,    110, 0, 252, 'medium', 'daily_kills'),
  ('daily_boss_1',         'daily',  'boss_kills',         1,    160, 0, 350, 'hard',   'daily_level'),
  ('daily_evolution',      'daily',  'evolution_runs',     1,    160, 0, 351, 'hard',   'daily_level'),
  ('weekly_chest_5',       'weekly', 'chests_opened',      5,    300, 0, 150, 'easy',   'weekly_runs'),
  ('weekly_elite_5',       'weekly', 'elite_kills',        5,    300, 0, 151, 'easy',   'weekly_runs'),
  ('weekly_chest_12',      'weekly', 'chests_opened',      12,   550, 0, 250, 'medium', 'weekly_kills'),
  ('weekly_crystals_5000', 'weekly', 'crystals_collected', 5000, 550, 0, 251, 'medium', 'weekly_kills'),
  ('weekly_elite_15',      'weekly', 'elite_kills',        15,   550, 0, 252, 'medium', 'weekly_kills'),
  ('weekly_boss_3',        'weekly', 'boss_kills',         3,    900, 5, 350, 'hard',   'weekly_best_540'),
  ('weekly_evolution_2',   'weekly', 'evolution_runs',     2,    900, 5, 351, 'hard',   'weekly_best_540')
) AS v ("task_id", "period", "kind", "target", "coins", "shards", "sort", "tier", "anchor")
JOIN "task_def" AS a ON a."task_id" = v."anchor"
ON CONFLICT ("task_id") DO NOTHING;

-- Достижения: 17 строк пяти лестниц (бой — элиты и боссы, коллекция — сундуки,
-- кристаллы и эволюции). Награда монетами и престиж — по лестницам T-0106:
-- 100 / 200 / 400 / 800 и 5 / 10 / 20 / 40 для четырёх ступеней, 100 / 200 / 400 и
-- 5 / 10 / 20 для трёх; у «боссов» и «эволюций» вдвое больше (200 / 400 / 800 и
-- 10 / 20 / 40) — их труднее получить. Скрытых и подсказок нет. `sort` — с 600
-- шагом 10 после существующих.
INSERT INTO "task_def" ("task_id", "period", "kind", "filter", "target", "title", "hint", "category", "ladder", "rung", "hidden", "prestige", "coins", "sort", "created_at", "updated_at") VALUES
  -- Бой: элиты
  ('ach_elite_1',      'achievement', 'elite_kills', NULL, 1,   'Первая элита',     NULL, 'combat', 'elite', 1, false, 5,  100, 600, now(), now()),
  ('ach_elite_10',     'achievement', 'elite_kills', NULL, 10,  'Охотник на элит',  NULL, 'combat', 'elite', 2, false, 10, 200, 610, now(), now()),
  ('ach_elite_50',     'achievement', 'elite_kills', NULL, 50,  'Гроза элит',       NULL, 'combat', 'elite', 3, false, 20, 400, 620, now(), now()),
  ('ach_elite_200',    'achievement', 'elite_kills', NULL, 200, 'Погибель элит',    NULL, 'combat', 'elite', 4, false, 40, 800, 630, now(), now()),
  -- Бой: боссы
  ('ach_boss_1',       'achievement', 'boss_kills',  NULL, 1,   'Первый босс',          NULL, 'combat', 'boss', 1, false, 10, 200, 640, now(), now()),
  ('ach_boss_5',       'achievement', 'boss_kills',  NULL, 5,   'Истребитель боссов',   NULL, 'combat', 'boss', 2, false, 20, 400, 650, now(), now()),
  ('ach_boss_25',      'achievement', 'boss_kills',  NULL, 25,  'Гроза боссов',         NULL, 'combat', 'boss', 3, false, 40, 800, 660, now(), now()),
  -- Коллекция: сундуки
  ('ach_chest_1',      'achievement', 'chests_opened', NULL, 1,   'Первая находка',   NULL, 'collection', 'chest', 1, false, 5,  100, 670, now(), now()),
  ('ach_chest_10',     'achievement', 'chests_opened', NULL, 10,  'Кладоискатель',    NULL, 'collection', 'chest', 2, false, 10, 200, 680, now(), now()),
  ('ach_chest_50',     'achievement', 'chests_opened', NULL, 50,  'Хозяин сундуков',  NULL, 'collection', 'chest', 3, false, 20, 400, 690, now(), now()),
  ('ach_chest_200',    'achievement', 'chests_opened', NULL, 200, 'Король сундуков',  NULL, 'collection', 'chest', 4, false, 40, 800, 700, now(), now()),
  -- Коллекция: кристаллы
  ('ach_crystal_1k',   'achievement', 'crystals_collected', NULL, 1000,   'Горсть кристаллов',  NULL, 'collection', 'crystal', 1, false, 5,  100, 710, now(), now()),
  ('ach_crystal_10k',  'achievement', 'crystals_collected', NULL, 10000,  'Мешок кристаллов',   NULL, 'collection', 'crystal', 2, false, 10, 200, 720, now(), now()),
  ('ach_crystal_100k', 'achievement', 'crystals_collected', NULL, 100000, 'Кристальная гора',   NULL, 'collection', 'crystal', 3, false, 20, 400, 730, now(), now()),
  -- Коллекция: эволюции оружия
  ('ach_evolution_1',  'achievement', 'evolution_runs', NULL, 1,  'Превращение',        NULL, 'collection', 'evolution', 1, false, 10, 200, 740, now(), now()),
  ('ach_evolution_5',  'achievement', 'evolution_runs', NULL, 5,  'Эволюционист',       NULL, 'collection', 'evolution', 2, false, 20, 400, 750, now(), now()),
  ('ach_evolution_25', 'achievement', 'evolution_runs', NULL, 25, 'Мастер превращений', NULL, 'collection', 'evolution', 3, false, 40, 800, 760, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
