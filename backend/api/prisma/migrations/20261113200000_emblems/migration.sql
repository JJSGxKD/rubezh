-- Знаки у имени (docs/35-stage4-plan.md Р149, tasks/T-0235). Знак — достижение,
-- которое носят: у отобранных достижений появляется редкость знака, а статусы
-- (VIP, Тестер, Меценат, Команда) и места недельного сезона (Чемпион, Топ-10,
-- Топ-100) — строки того же каталога `task_def` с новыми видами `status` и
-- `season`. Прогресса у статусных и сезонных знаков нет: держит ли игрок знак,
-- сервер считает при чтении по состоянию аккаунта, поэтому истёкший VIP ничего
-- не снимает. Игрок выбирает, какой знак носить, — `account.shown_emblem_id`.

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "shown_emblem_id" VARCHAR(48);

-- AlterTable
ALTER TABLE "task_def" ADD COLUMN     "emblem_tier" VARCHAR(16);

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_shown_emblem_id_fkey" FOREIGN KEY ("shown_emblem_id") REFERENCES "task_def"("task_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ошибка в панели или в коде упрётся в базу, а не в игрока. Редкость знака —
-- шкала предметов (`common`…`mythic`) и `team` для знака «Команда», и только у
-- достижений: у задания дня знака не бывает.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_emblem_tier_check" CHECK ("emblem_tier" IS NULL OR "emblem_tier" IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'team'));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_emblem_period_check" CHECK ("emblem_tier" IS NULL OR "period"::text = 'achievement');

-- Категории `status` и `season` — только у одноимённых видов цели, и наоборот.
ALTER TABLE "task_def" DROP CONSTRAINT "task_def_category_check";
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_category_check" CHECK ("category" IS NULL OR "category" IN ('combat', 'collection', 'mastery', 'friends', 'status', 'season'));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_emblem_kind_check" CHECK (
  ("kind" = 'status') = (COALESCE("category", '') = 'status')
  AND ("kind" = 'season') = (COALESCE("category", '') = 'season')
);

-- Награда у статусных и сезонных знаков нулевая: проверка «без награды задание
-- некому выполнять» остаётся для всего остального.
ALTER TABLE "task_def" DROP CONSTRAINT "task_def_reward_check";
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_reward_check" CHECK (
  "coins" >= 0 AND "gems" >= 0 AND "shards" >= 0
  AND ("coins" + "gems" + "shards" > 0 OR "kind" IN ('status', 'season'))
);

-- 24 отобранных достижения: верхние ступени лестниц, скрытые и «Мастера оружия».
-- Редкость стартовая, геймдизайнер калибрует её в панели и не плавает вместе с
-- «есть у N%»: цвет знака у имени не должен меняться сам.
UPDATE "task_def" AS d SET "emblem_tier" = v."emblem_tier"
FROM (VALUES
  ('ach_kills_100k',       'legendary'),
  ('ach_time_100h',        'legendary'),
  ('ach_account_50',       'legendary'),
  ('ach_xp_500k',          'epic'),
  ('ach_survive_20',       'epic'),
  ('ach_level_40',         'epic'),
  ('ach_runs_200',         'epic'),
  ('ach_hard_5',           'epic'),
  ('ach_friends_25',       'epic'),
  ('ach_boost_50',         'rare'),
  ('ach_elite_200',        'legendary'),
  ('ach_boss_25',          'legendary'),
  ('ach_chest_200',        'epic'),
  ('ach_crystal_100k',     'epic'),
  ('ach_evolution_25',     'epic'),
  ('ach_hidden_hard_7',    'mythic'),
  ('ach_hidden_marathon',  'mythic'),
  ('ach_hidden_level_60',  'legendary'),
  ('ach_weapon_spark',     'uncommon'),
  ('ach_weapon_knife',     'uncommon'),
  ('ach_weapon_wardstone', 'uncommon'),
  ('ach_weapon_hearth',    'uncommon'),
  ('ach_weapon_storm',     'uncommon'),
  ('ach_weapon_sting',     'uncommon')
) AS v ("task_id", "emblem_tier")
WHERE d."task_id" = v."task_id" AND d."period"::text = 'achievement';

-- Семь статусных и сезонных знаков. Цель 1, награда и престиж нулевые, скрытости
-- нет; `hint` — условие, которое игрок видит у закрытого знака. `sort` — с 900
-- шагом 10 после существующих достижений. Не заводятся заново, если строка уже
-- есть (в том числе поправленная в панели).
INSERT INTO "task_def" ("task_id", "period", "kind", "target", "title", "hint", "category", "emblem_tier", "hidden", "prestige", "coins", "gems", "shards", "pass_points", "sort", "created_at", "updated_at") VALUES
  ('emb_vip',             'achievement', 'status', 1, 'VIP',      'Оформить VIP',                          'status', 'legendary', false, 0, 0, 0, 0, 0, 900, now(), now()),
  ('emb_tester',          'achievement', 'status', 1, 'Тестер',   'Играть в закрытом тесте',               'status', 'rare',      false, 0, 0, 0, 0, 0, 910, now(), now()),
  ('emb_supporter',       'achievement', 'status', 1, 'Меценат',  'Поддержать проект',                     'status', 'epic',      false, 0, 0, 0, 0, 0, 920, now(), now()),
  ('emb_team',            'achievement', 'status', 1, 'Команда',  'Работать в команде игры',               'status', 'team',      false, 0, 0, 0, 0, 0, 930, now(), now()),
  ('emb_season_champion', 'achievement', 'season', 1, 'Чемпион',  'Занять первое место в недельном сезоне', 'season', 'mythic',    false, 0, 0, 0, 0, 0, 940, now(), now()),
  ('emb_season_top10',    'achievement', 'season', 1, 'Топ-10',   'Войти в десятку недельного сезона',     'season', 'legendary', false, 0, 0, 0, 0, 0, 950, now(), now()),
  ('emb_season_top100',   'achievement', 'season', 1, 'Топ-100',  'Войти в сотню недельного сезона',       'season', 'epic',      false, 0, 0, 0, 0, 0, 960, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
