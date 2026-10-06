-- CreateEnum
CREATE TYPE "TaskPeriod" AS ENUM ('daily', 'weekly', 'achievement');

-- CreateTable
CREATE TABLE "task_def" (
    "task_id" VARCHAR(48) NOT NULL,
    "period" "TaskPeriod" NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "target" INTEGER NOT NULL,
    "title" VARCHAR(120),
    "coins" INTEGER NOT NULL DEFAULT 0,
    "gems" INTEGER NOT NULL DEFAULT 0,
    "shards" INTEGER NOT NULL DEFAULT 0,
    "pass_points" INTEGER NOT NULL DEFAULT 0,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "task_def_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "task_progress" (
    "account_id" UUID NOT NULL,
    "task_id" VARCHAR(48) NOT NULL,
    "period_start" DATE NOT NULL,
    "value" INTEGER NOT NULL,
    "target" INTEGER NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "claimed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_progress_pkey" PRIMARY KEY ("account_id","task_id","period_start")
);

-- CreateTable
CREATE TABLE "task_run" (
    "run_id" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_run_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "task_run_account_id_idx" ON "task_run"("account_id");

-- AddForeignKey
ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_def"("task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Цель и награда — не пустые, прогресс — не за целью, забрать можно только
-- выполненное: ошибка в панели или в коде упрётся в базу, а не в игрока.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_target_check" CHECK ("target" > 0);
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_reward_check" CHECK ("coins" >= 0 AND "gems" >= 0 AND "shards" >= 0 AND "coins" + "gems" + "shards" > 0);
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_pass_points_check" CHECK ("pass_points" >= 0);
ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_value_check" CHECK ("value" >= 0 AND "value" <= "target");
ALTER TABLE "task_progress" ADD CONSTRAINT "task_progress_claim_check" CHECK ("claimed_at" IS NULL OR "completed_at" IS NOT NULL);

-- Каталог по умолчанию (О12 — рабочие числа, docs/35-stage4-plan.md WP13):
-- ежедневные — около 500 монет в сутки при ~1 300 из забегов, неделя — около
-- 2 800 и осколки; самоцветы — только у достижений. Дальше каталог правится
-- из панели.
INSERT INTO "task_def" ("task_id", "period", "kind", "target", "coins", "gems", "shards", "sort", "created_at", "updated_at") VALUES
  ('daily_runs',      'daily',       'runs',              3,     120,  0,  0,  10, now(), now()),
  ('daily_kills',     'daily',       'kills',             1000,  150,  0,  0,  20, now(), now()),
  ('daily_survive',   'daily',       'survive_sec',       900,   150,  0,  3,  30, now(), now()),
  ('daily_level',     'daily',       'run_level',         20,    100,  0,  0,  40, now(), now()),
  ('weekly_runs',     'weekly',      'runs',              25,    800,  0,  10, 10, now(), now()),
  ('weekly_kills',    'weekly',      'kills',             10000, 1000, 0,  0,  20, now(), now()),
  ('weekly_survive',  'weekly',      'survive_sec',       7200,  1000, 0,  10, 30, now(), now()),
  ('ach_survive_1',   'achievement', 'best_survival_sec', 60,    100,  0,  0,  10, now(), now()),
  ('ach_survive_5',   'achievement', 'best_survival_sec', 300,   0,    5,  0,  20, now(), now()),
  ('ach_survive_10',  'achievement', 'best_survival_sec', 600,   0,    10, 0,  30, now(), now()),
  ('ach_survive_20',  'achievement', 'best_survival_sec', 1200,  0,    20, 0,  40, now(), now()),
  ('ach_runs_10',     'achievement', 'runs',              10,    300,  0,  0,  50, now(), now()),
  ('ach_runs_50',     'achievement', 'runs',              50,    0,    10, 0,  60, now(), now()),
  ('ach_runs_200',    'achievement', 'runs',              200,   0,    25, 0,  70, now(), now()),
  ('ach_kills_50k',   'achievement', 'kills',             50000, 0,    15, 0,  80, now(), now()),
  ('ach_level_40',    'achievement', 'run_level',         40,    0,    10, 0,  90, now(), now());
