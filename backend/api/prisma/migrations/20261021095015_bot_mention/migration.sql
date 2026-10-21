-- CreateTable
CREATE TABLE "bot_mention_task" (
    "account_id" UUID NOT NULL,
    "kind" VARCHAR(4) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "best_streak" INTEGER NOT NULL DEFAULT 0,
    "rewarded_days" INTEGER NOT NULL DEFAULT 0,
    "last_day" DATE,
    "checked_day" DATE,
    "checked_at" TIMESTAMPTZ(3),
    "last_result" VARCHAR(11),

    CONSTRAINT "bot_mention_task_pkey" PRIMARY KEY ("account_id","kind")
);

-- CreateIndex
CREATE INDEX "bot_mention_task_checked_day_idx" ON "bot_mention_task"("checked_day");

-- AddForeignKey
ALTER TABLE "bot_mention_task" ADD CONSTRAINT "bot_mention_task_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Допустимые значения: Prisma их не выражает. Вид — имя или bio; исход — то, что вернула
-- площадка. Текст имени и bio в таблицу не попадает никогда.
ALTER TABLE "bot_mention_task" ADD CONSTRAINT "bot_mention_task_kind_check" CHECK ("kind" IN ('name', 'bio'));
ALTER TABLE "bot_mention_task" ADD CONSTRAINT "bot_mention_task_last_result_check" CHECK ("last_result" IS NULL OR "last_result" IN ('present', 'absent', 'hidden', 'unavailable'));

-- Откат: DROP TABLE "bot_mention_task";
