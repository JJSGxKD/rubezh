-- Перепроверка подписки после награды (docs/35-stage4-plan.md Р115, tasks/T-0178):
-- по строке на каждую выданную награду за подписку на канал. Таблица новая и
-- пустая, награды, выданные до выката, под наблюдение не попадают. Откат — DROP TABLE.

-- CreateTable
CREATE TABLE "task_channel_watch" (
    "account_id" UUID NOT NULL,
    "task_id" VARCHAR(48) NOT NULL,
    "period_start" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "watch_until" TIMESTAMPTZ(3) NOT NULL,
    "next_check_at" TIMESTAMPTZ(3) NOT NULL,
    "checked_at" TIMESTAMPTZ(3),
    "state" VARCHAR(16) NOT NULL DEFAULT 'watching',
    "event_no" INTEGER,
    "penalized_at" TIMESTAMPTZ(3),
    "revoked" JSONB,

    CONSTRAINT "task_channel_watch_pkey" PRIMARY KEY ("account_id","task_id","period_start")
);

-- CreateIndex
CREATE INDEX "task_channel_watch_account_id_task_id_idx" ON "task_channel_watch"("account_id", "task_id");

-- AddForeignKey
ALTER TABLE "task_channel_watch" ADD CONSTRAINT "task_channel_watch_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_channel_watch" ADD CONSTRAINT "task_channel_watch_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_def"("task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Состояние окна: ждёт проверок, досидел, кончилось без ответа площадки, отписался.
ALTER TABLE "task_channel_watch" ADD CONSTRAINT "task_channel_watch_state_check" CHECK ("state" IN ('watching', 'kept', 'expired', 'penalized'));

-- Номер события отписки и момент штрафа — только у оштрафованного окна и только вместе.
ALTER TABLE "task_channel_watch" ADD CONSTRAINT "task_channel_watch_penalty_check" CHECK (
  ("state" = 'penalized' AND "event_no" IS NOT NULL AND "event_no" >= 1 AND "penalized_at" IS NOT NULL)
  OR ("state" <> 'penalized' AND "event_no" IS NULL AND "penalized_at" IS NULL)
);

-- Окно кончается позже, чем началось.
ALTER TABLE "task_channel_watch" ADD CONSTRAINT "task_channel_watch_span_check" CHECK ("watch_until" > "started_at");

-- Окна к проверке: проход берёт только `watching` с наступившим сроком. Частичный индекс: Prisma его
-- не описывает, поэтому он только здесь. Закрытые окна, которых со временем большинство, в него не попадают.
CREATE INDEX "task_channel_watch_due_idx" ON "task_channel_watch"("next_check_at") WHERE "state" = 'watching';
