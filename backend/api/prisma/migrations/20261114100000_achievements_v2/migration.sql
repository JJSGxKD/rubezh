-- Достижения v2 (docs/35-stage4-plan.md Р161, tasks/T-0322, design/art/meta-v2.md §6.3):
-- два испытания мастерства, четыре лестницы стихийников, «Коллекционер» всех
-- «Мастеров оружия» и «Мастер Метеора», которого не хватало. Только строки
-- каталога `task_def`: колонок и ограничений новые виды не требуют, а вид цели
-- сервер читает по строке (`kind`) — старая сборка незнакомые строки пропускает.
--
-- Числа стартовые, геймдизайнер калибрует их в панели. Знак у имени (Р149) — только
-- у трудных: «Без единой царапины», «Коллекционера» и верхних ступеней стихийников;
-- «Мастер Метеора» — как остальные «Мастера оружия». Награда — монеты, без самоцветов.
--
-- «Коллекционер»: хранимая цель строки сервером не читается — она равна числу
-- включённых «Мастеров оружия» (`DYNAMIC_TARGET_KINDS`), семь — лишь стартовое
-- значение для панели. `sort` — после последнего достижения с шагом 10 (970…1120).
-- Повтор миграции строки не затирает: правки из панели остаются.
INSERT INTO "task_def" ("task_id", "period", "kind", "filter", "target", "title", "hint", "category", "ladder", "rung", "hidden", "prestige", "coins", "emblem_tier", "sort", "created_at", "updated_at") VALUES
  -- Мастерство: испытания по итогу одного забега
  ('ach_no_hit_10',     'achievement', 'no_hit_sec',     NULL,                          600,   'Без единой царапины', NULL, 'mastery', NULL, NULL, false, 40, 800, 'legendary', 970,  now(), now()),
  ('ach_pacifist',      'achievement', 'no_kill_sec',    NULL,                          60,    'Пацифист',            NULL, 'mastery', NULL, NULL, false, 10, 150, NULL,        980,  now(), now()),
  -- Бой: убийства стихией (огонь, холод, молния, яд — по три ступени)
  ('ach_fire_500',      'achievement', 'element_kills',  '{"element": "fire"}'::jsonb,      500,   'Поджигатель',   NULL, 'combat', 'fire_kills',      1, false, 5,  100, NULL,   990,  now(), now()),
  ('ach_fire_2500',     'achievement', 'element_kills',  '{"element": "fire"}'::jsonb,      2500,  'Пламенный',     NULL, 'combat', 'fire_kills',      2, false, 10, 200, NULL,   1000, now(), now()),
  ('ach_fire_10k',      'achievement', 'element_kills',  '{"element": "fire"}'::jsonb,      10000, 'Огнепоклонник', NULL, 'combat', 'fire_kills',      3, false, 20, 400, 'epic', 1010, now(), now()),
  ('ach_cold_500',      'achievement', 'element_kills',  '{"element": "cold"}'::jsonb,      500,   'Иней',          NULL, 'combat', 'cold_kills',      1, false, 5,  100, NULL,   1020, now(), now()),
  ('ach_cold_2500',     'achievement', 'element_kills',  '{"element": "cold"}'::jsonb,      2500,  'Мороз',         NULL, 'combat', 'cold_kills',      2, false, 10, 200, NULL,   1030, now(), now()),
  ('ach_cold_10k',      'achievement', 'element_kills',  '{"element": "cold"}'::jsonb,      10000, 'Стужа',         NULL, 'combat', 'cold_kills',      3, false, 20, 400, 'epic', 1040, now(), now()),
  ('ach_lightning_500', 'achievement', 'element_kills',  '{"element": "lightning"}'::jsonb, 500,   'Искрящий',      NULL, 'combat', 'lightning_kills', 1, false, 5,  100, NULL,   1050, now(), now()),
  ('ach_lightning_2500','achievement', 'element_kills',  '{"element": "lightning"}'::jsonb, 2500,  'Грозовой',      NULL, 'combat', 'lightning_kills', 2, false, 10, 200, NULL,   1060, now(), now()),
  ('ach_lightning_10k', 'achievement', 'element_kills',  '{"element": "lightning"}'::jsonb, 10000, 'Громовержец',   NULL, 'combat', 'lightning_kills', 3, false, 20, 400, 'epic', 1070, now(), now()),
  ('ach_poison_500',    'achievement', 'element_kills',  '{"element": "poison"}'::jsonb,    500,   'Знахарь',       NULL, 'combat', 'poison_kills',    1, false, 5,  100, NULL,   1080, now(), now()),
  ('ach_poison_2500',   'achievement', 'element_kills',  '{"element": "poison"}'::jsonb,    2500,  'Ядовитый',      NULL, 'combat', 'poison_kills',    2, false, 10, 200, NULL,   1090, now(), now()),
  ('ach_poison_10k',    'achievement', 'element_kills',  '{"element": "poison"}'::jsonb,    10000, 'Отравитель',    NULL, 'combat', 'poison_kills',    3, false, 20, 400, 'epic', 1100, now(), now()),
  -- Коллекция: все «Мастера оружия» разом и недостающий «Мастер Метеора»
  ('ach_collector',     'achievement', 'weapon_masters', NULL,                          7,     'Коллекционер',   NULL, 'collection', NULL, NULL, false, 40, 800, 'epic',     1110, now(), now()),
  ('ach_weapon_meteor', 'achievement', 'weapon_runs',    '{"weapon": "meteor"}'::jsonb,     5,     'Мастер Метеора', NULL, 'collection', NULL, NULL, false, 10, 150, 'uncommon', 1120, now(), now())
ON CONFLICT ("task_id") DO NOTHING;

-- Ступень «5 друзей» зовётся «Душа компании»: второго достижения не заводим, цель,
-- награда и престиж прежние, знака нет — оно лёгкое (Р161).
UPDATE "task_def" SET "title" = 'Душа компании' WHERE "task_id" = 'ach_friends_5';
