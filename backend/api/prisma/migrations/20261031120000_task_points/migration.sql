-- Очки заданий (docs/39-retention-mechanics.md П2, docs/35-stage4-plan.md Р102,
-- tasks/T-0105): задание, выполненное в срок, даёт очки из колонки
-- `pass_points`, а на полосе дня и недели три ступени, каждая — награда. Забранная
-- ступень — строка в этой таблице; ключ — срок (начало суток или недели по
-- Москве) и порог: прошлые сутки и неделя не забираются, а повторный забор
-- упирается в ключ.
CREATE TABLE "task_points_claim" (
    "account_id" UUID NOT NULL,
    "period" "TaskPeriod" NOT NULL,
    "period_start" DATE NOT NULL,
    "points" INTEGER NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_points_claim_pkey" PRIMARY KEY ("account_id", "period", "period_start", "points"),
    CONSTRAINT "task_points_claim_period_check" CHECK ("period"::text IN ('daily', 'weekly')),
    CONSTRAINT "task_points_claim_points_check" CHECK ("points" > 0)
);

ALTER TABLE "task_points_claim" ADD CONSTRAINT "task_points_claim_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Очки заданий по ступени пула ротации (старт, геймдизайнер калибрует): набор
-- из пяти дневных даёт 100 очков, из шести недельных — 240. Строки без ступени
-- (партнёрские цели, достижения, добавленные руками) остаются с прежними очками.
UPDATE "task_def" SET "pass_points" = CASE "period"::text
    WHEN 'daily' THEN CASE "tier" WHEN 'easy' THEN 10 WHEN 'medium' THEN 20 ELSE 40 END
    ELSE CASE "tier" WHEN 'easy' THEN 20 WHEN 'medium' THEN 40 ELSE 80 END
  END
WHERE "tier" IS NOT NULL;
