-- Достижения с престижем (docs/39-retention-mechanics.md К1, docs/35-stage4-plan.md
-- Р102, tasks/T-0106). Определения остаются в `task_def` с периодом `achievement`:
-- забег, защита от повтора, забор и потолок кошелька уже работают на этих таблицах.
-- Новое — колонки определения, редкость «есть у N%» и три любимых достижения игрока.
-- Только добавление: прогресс и награды существующих девяти достижений не меняются.
--
-- Лестница — несколько строк с общим `ladder` и номером `rung` с единицы; каждая
-- ступень считает с нуля независимо. Скрытое (`hidden`) сервер до выполнения не
-- отдаёт целиком, только подсказку `hint`. Престиж — очки за выполненное.

-- AlterTable
ALTER TABLE "task_def" ADD COLUMN     "category" VARCHAR(16),
ADD COLUMN     "hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hint" VARCHAR(120),
ADD COLUMN     "ladder" VARCHAR(32),
ADD COLUMN     "prestige" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rung" SMALLINT;

-- CreateTable
CREATE TABLE "achievement_rarity" (
    "task_id" VARCHAR(48) NOT NULL,
    "holders" INTEGER NOT NULL,
    "population" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "achievement_rarity_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "achievement_favorite" (
    "account_id" UUID NOT NULL,
    "slot" SMALLINT NOT NULL,
    "task_id" VARCHAR(48) NOT NULL,

    CONSTRAINT "achievement_favorite_pkey" PRIMARY KEY ("account_id","slot")
);

-- CreateIndex
CREATE UNIQUE INDEX "achievement_favorite_account_id_task_id_key" ON "achievement_favorite"("account_id", "task_id");

-- AddForeignKey
ALTER TABLE "achievement_rarity" ADD CONSTRAINT "achievement_rarity_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_def"("task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievement_favorite" ADD CONSTRAINT "achievement_favorite_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievement_favorite" ADD CONSTRAINT "achievement_favorite_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_def"("task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ошибка в панели или в коде упрётся в базу, а не в игрока: поля достижения —
-- только у достижений, ступень и лестница — вместе, скрытому нужна подсказка.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_category_check" CHECK ("category" IS NULL OR "category" IN ('combat', 'collection', 'mastery', 'friends'));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_ladder_check" CHECK (("ladder" IS NULL) = ("rung" IS NULL));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_rung_check" CHECK ("rung" IS NULL OR "rung" > 0);
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_prestige_check" CHECK ("prestige" >= 0);
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_hidden_hint_check" CHECK ("hidden" = false OR "hint" IS NOT NULL);
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_achievement_fields_check" CHECK (
  "period"::text = 'achievement'
  OR ("category" IS NULL AND "ladder" IS NULL AND "rung" IS NULL AND "hint" IS NULL AND "hidden" = false AND "prestige" = 0)
);
ALTER TABLE "achievement_rarity" ADD CONSTRAINT "achievement_rarity_counts_check" CHECK ("holders" >= 0 AND "population" >= 0);
ALTER TABLE "achievement_favorite" ADD CONSTRAINT "achievement_favorite_slot_check" CHECK ("slot" BETWEEN 1 AND 3);

-- Девять существующих достижений: категория, лестница, ступень, престиж и название
-- (те же слова, что в клиентском словаре `achievement.<id>.name`). Цели и награды не
-- трогаем — часть наград самоцветы, и игроки могли их уже забрать; название, которое
-- команда успела поправить в панели, не затираем.
UPDATE "task_def" AS d SET
  "category" = v."category",
  "ladder" = v."ladder",
  "rung" = v."rung",
  "prestige" = v."prestige",
  "title" = COALESCE(d."title", v."title")
FROM (VALUES
  ('ach_survive_1',  'mastery', 'survive', 1, 5,  'Первая минута'),
  ('ach_survive_5',  'mastery', 'survive', 2, 10, 'Держи рубеж'),
  ('ach_survive_10', 'mastery', 'survive', 3, 20, 'Несокрушимый'),
  ('ach_survive_20', 'mastery', 'survive', 4, 40, 'Последний рубеж'),
  ('ach_runs_10',    'mastery', 'runs',    2, 10, 'Бывалый'),
  ('ach_runs_50',    'mastery', 'runs',    3, 20, 'Ветеран'),
  ('ach_runs_200',   'mastery', 'runs',    4, 40, 'Старожил'),
  ('ach_kills_50k',  'combat',  'kills',   4, 40, 'Гроза орды'),
  ('ach_level_40',   'mastery', 'level',   4, 40, 'Мастер забега')
) AS v ("task_id", "category", "ladder", "rung", "prestige", "title")
WHERE d."task_id" = v."task_id";

-- Новые достижения (числа стартовые, геймдизайнер калибрует): награда — монеты, без
-- самоцветов. Порядок строк — порядок в списке: `sort` с шагом 10 после девяти
-- существующих (10…90). Цели на сложность — только «Сложная» (Р126, единая сложность):
-- «Середина пути» на «Нормальной» не заводится, её цель 300 с у «Несгибаемого».
INSERT INTO "task_def" ("task_id", "period", "kind", "filter", "target", "title", "hint", "category", "ladder", "rung", "hidden", "prestige", "coins", "sort", "created_at", "updated_at") VALUES
  -- Бой: убийства
  ('ach_kills_100',   'achievement', 'kills',  NULL, 100,    'Первая сотня',  NULL, 'combat', 'kills', 1, false, 5,  100,  100, now(), now()),
  ('ach_kills_1k',    'achievement', 'kills',  NULL, 1000,   'Тысячник',      NULL, 'combat', 'kills', 2, false, 10, 200,  110, now(), now()),
  ('ach_kills_10k',   'achievement', 'kills',  NULL, 10000,  'Косарь',        NULL, 'combat', 'kills', 3, false, 20, 400,  120, now(), now()),
  ('ach_kills_100k',  'achievement', 'kills',  NULL, 100000, 'Погибель орды', NULL, 'combat', 'kills', 5, false, 80, 1500, 130, now(), now()),
  -- Бой: опыт
  ('ach_xp_5k',       'achievement', 'xp_collected', NULL, 5000,   'Искатель кристаллов', NULL, 'combat', 'xp', 1, false, 5,  100, 140, now(), now()),
  ('ach_xp_50k',      'achievement', 'xp_collected', NULL, 50000,  'Собиратель',          NULL, 'combat', 'xp', 2, false, 10, 200, 150, now(), now()),
  ('ach_xp_500k',     'achievement', 'xp_collected', NULL, 500000, 'Кристальный магнат',  NULL, 'combat', 'xp', 3, false, 20, 400, 160, now(), now()),
  -- Бой: время в сумме
  ('ach_time_1h',     'achievement', 'survive_sec', NULL, 3600,   'Час на рубеже',      NULL, 'combat', 'time', 1, false, 5,  100, 170, now(), now()),
  ('ach_time_10h',    'achievement', 'survive_sec', NULL, 36000,  'Десять часов в бою', NULL, 'combat', 'time', 2, false, 10, 200, 180, now(), now()),
  ('ach_time_100h',   'achievement', 'survive_sec', NULL, 360000, 'Сто часов на посту', NULL, 'combat', 'time', 3, false, 20, 400, 190, now(), now()),
  -- Коллекция: бусты
  ('ach_boost_1',     'achievement', 'boost_runs', NULL, 1,  'Подготовка',        NULL, 'collection', 'boost', 1, false, 5,  100, 200, now(), now()),
  ('ach_boost_10',    'achievement', 'boost_runs', NULL, 10, 'Запасливый',        NULL, 'collection', 'boost', 2, false, 10, 200, 210, now(), now()),
  ('ach_boost_50',    'achievement', 'boost_runs', NULL, 50, 'Снаряжён до зубов', NULL, 'collection', 'boost', 3, false, 20, 400, 220, now(), now()),
  -- Коллекция: мастера оружия (забегов с оружием в наборе к концу)
  ('ach_weapon_spark',     'achievement', 'weapon_runs', '{"weapon": "spark"}'::jsonb,     5, 'Мастер Искры',   NULL, 'collection', NULL, NULL, false, 10, 150, 230, now(), now()),
  ('ach_weapon_knife',     'achievement', 'weapon_runs', '{"weapon": "knife"}'::jsonb,     5, 'Мастер Ножа',    NULL, 'collection', NULL, NULL, false, 10, 150, 240, now(), now()),
  ('ach_weapon_wardstone', 'achievement', 'weapon_runs', '{"weapon": "wardstone"}'::jsonb, 5, 'Мастер Оберега', NULL, 'collection', NULL, NULL, false, 10, 150, 250, now(), now()),
  ('ach_weapon_hearth',    'achievement', 'weapon_runs', '{"weapon": "hearth"}'::jsonb,    5, 'Мастер Очага',   NULL, 'collection', NULL, NULL, false, 10, 150, 260, now(), now()),
  ('ach_weapon_storm',     'achievement', 'weapon_runs', '{"weapon": "storm"}'::jsonb,     5, 'Мастер Грозы',   NULL, 'collection', NULL, NULL, false, 10, 150, 270, now(), now()),
  ('ach_weapon_sting',     'achievement', 'weapon_runs', '{"weapon": "sting"}'::jsonb,     5, 'Мастер Жала',    NULL, 'collection', NULL, NULL, false, 10, 150, 280, now(), now()),
  -- Коллекция: повелители стихий (забегов с оружием стихии)
  ('ach_element_fire',      'achievement', 'element_runs', '{"element": "fire"}'::jsonb,      10, 'Повелитель огня',   NULL, 'collection', NULL, NULL, false, 10, 150, 290, now(), now()),
  ('ach_element_cold',      'achievement', 'element_runs', '{"element": "cold"}'::jsonb,      10, 'Повелитель холода', NULL, 'collection', NULL, NULL, false, 10, 150, 300, now(), now()),
  ('ach_element_lightning', 'achievement', 'element_runs', '{"element": "lightning"}'::jsonb, 10, 'Повелитель молний', NULL, 'collection', NULL, NULL, false, 10, 150, 310, now(), now()),
  ('ach_element_poison',    'achievement', 'element_runs', '{"element": "poison"}'::jsonb,    10, 'Повелитель яда',    NULL, 'collection', NULL, NULL, false, 10, 150, 320, now(), now()),
  -- Мастерство: уровень в забеге (сороковой уровень — «Мастер забега», он уже есть)
  ('ach_level_10',    'achievement', 'run_level', NULL, 10, 'Разгон',        NULL, 'mastery', 'level', 1, false, 5,  100, 330, now(), now()),
  ('ach_level_20',    'achievement', 'run_level', NULL, 20, 'Закалка',       NULL, 'mastery', 'level', 2, false, 10, 200, 340, now(), now()),
  ('ach_level_30',    'achievement', 'run_level', NULL, 30, 'Опытный боец',  NULL, 'mastery', 'level', 3, false, 20, 400, 350, now(), now()),
  -- Мастерство: забеги (десятый, пятидесятый и двухсотый уже есть)
  ('ach_runs_1',      'achievement', 'runs', NULL, 1, 'Первый забег', NULL, 'mastery', 'runs', 1, false, 5, 50, 360, now(), now()),
  -- Мастерство: время в одном забеге на «Сложной»
  ('ach_hard_3',      'achievement', 'difficulty_survive_sec', '{"difficulty": "hard"}'::jsonb, 180, 'Закалённый',   NULL, 'mastery', 'hard', 1, false, 20, 400, 370, now(), now()),
  ('ach_hard_5',      'achievement', 'difficulty_survive_sec', '{"difficulty": "hard"}'::jsonb, 300, 'Несгибаемый',  NULL, 'mastery', 'hard', 2, false, 40, 800, 380, now(), now()),
  -- Мастерство: уровень аккаунта (ступень обновляется при открытии витрины)
  ('ach_account_10',  'achievement', 'account_level', NULL, 10, 'Десятый уровень', NULL, 'mastery', 'account', 1, false, 10, 200, 390, now(), now()),
  ('ach_account_25',  'achievement', 'account_level', NULL, 25, 'Четверть сотни',  NULL, 'mastery', 'account', 2, false, 20, 400, 400, now(), now()),
  ('ach_account_50',  'achievement', 'account_level', NULL, 50, 'Полсотни',        NULL, 'mastery', 'account', 3, false, 40, 800, 410, now(), now()),
  -- Мастерство: скрытые, пока не выполнены
  ('ach_hidden_hard_7',    'achievement', 'difficulty_survive_sec', '{"difficulty": "hard"}'::jsonb, 420, 'Выстоявший',  'Выстоять там, где почти никто не выстаивает', 'mastery', NULL, NULL, true, 40, 500, 420, now(), now()),
  ('ach_hidden_marathon',  'achievement', 'best_survival_sec',      NULL,                            1800, 'Марафонец',   'Продержаться очень, очень долго',             'mastery', NULL, NULL, true, 40, 500, 430, now(), now()),
  ('ach_hidden_level_60',  'achievement', 'run_level',              NULL,                            60,  'Предел роста', 'Расти, пока растёшь',                         'mastery', NULL, NULL, true, 40, 500, 440, now(), now()),
  -- Друзья: сколько друзей (ступень обновляется при открытии витрины)
  ('ach_friends_1',   'achievement', 'friends', NULL, 1,  'Не один',     NULL, 'friends', 'friends', 1, false, 5,  100, 450, now(), now()),
  ('ach_friends_5',   'achievement', 'friends', NULL, 5,  'Свои люди',   NULL, 'friends', 'friends', 2, false, 10, 200, 460, now(), now()),
  ('ach_friends_10',  'achievement', 'friends', NULL, 10, 'Отряд',       NULL, 'friends', 'friends', 3, false, 20, 400, 470, now(), now()),
  ('ach_friends_25',  'achievement', 'friends', NULL, 25, 'Целый рубеж', NULL, 'friends', 'friends', 4, false, 40, 800, 480, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
