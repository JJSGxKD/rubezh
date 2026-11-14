-- Знак «Партнёр» у имени (docs/35-stage4-plan.md Р149, tasks/T-0480). Пятый
-- статусный знак: его держит аккаунт с ролью `partner`, чья карточка партнёра
-- (`partner.account_id`) в статусе `active`. Держит ли аккаунт знак, сервер
-- считает при чтении, поэтому приостановленный партнёр или закрытый кабинет
-- знак не снимают — он просто перестаёт держаться.

-- Своя редкость знака, как отдельная `team` у «Команды»: «Партнёр» — не
-- заслуга и не покупка. Список шкалы предметов и `team` остаётся прежним.
ALTER TABLE "task_def" DROP CONSTRAINT "task_def_emblem_tier_check";
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_emblem_tier_check" CHECK ("emblem_tier" IS NULL OR "emblem_tier" IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'team', 'partner'));

-- Строка знака по образцу `emb_team`: цель 1, награды и престижа нет. `sort`
-- 935 — между «Командой» (930) и сезонными знаками (с 940): место 940 уже
-- занято «Чемпионом». Не заводится заново, если строка уже есть (в том числе
-- поправленная в панели).
INSERT INTO "task_def" ("task_id", "period", "kind", "target", "title", "hint", "category", "emblem_tier", "hidden", "prestige", "coins", "gems", "shards", "pass_points", "sort", "created_at", "updated_at") VALUES
  ('emb_partner', 'achievement', 'status', 1, 'Партнёр', 'Быть партнёром игры', 'status', 'partner', false, 0, 0, 0, 0, 0, 935, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
