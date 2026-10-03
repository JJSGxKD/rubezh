-- Лимит выполнений партнёрских заданий (docs/35-stage4-plan.md Р82, WP13,
-- часть 7): сколько игроков получат награду. Исчерпан — задание пропадает у
-- тех, кто его не начинал; кто нажал «Подписаться» до этого, получает
-- награду ещё час.

-- Лимит — сколько игроков выполнят задание; пусто — без лимита. Счётчик
-- растёт одной строкой под блокировкой строки задания: два забора разом не
-- перешагнут лимит.
ALTER TABLE "task_def" ADD COLUMN "completion_limit" INTEGER;
ALTER TABLE "task_def" ADD COLUMN "completions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_completion_limit_check" CHECK ("completion_limit" IS NULL OR "completion_limit" BETWEEN 1 AND 1000000);
-- Лимит — только у партнёрской цели: у цели забега мест нет.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_completion_limit_kind_check" CHECK ("completion_limit" IS NULL OR "params" IS NOT NULL);

-- Участник партнёрского задания — строка на игрока, а не на срок: у
-- повторяемой подписки игрок занимает место однажды и дальше получает
-- награду каждый срок. `opened_at` — последний переход до исчерпания: от
-- него идёт мягкий час.
CREATE TABLE "task_participant" (
    "task_id" VARCHAR(48) NOT NULL,
    "account_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_participant_pkey" PRIMARY KEY ("task_id","account_id")
);

-- Строки игрока удаляются вместе с ним — по индексу, а не перебором; его
-- выполнение в счётчике остаётся: награда за него выдана.
CREATE INDEX "task_participant_account_id_idx" ON "task_participant"("account_id");

ALTER TABLE "task_participant" ADD CONSTRAINT "task_participant_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_def"("task_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_participant" ADD CONSTRAINT "task_participant_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Кто уже выполнил партнёрские задания — участники, и счётчик с них: иначе
-- лимит, заданный позже, считал бы с нуля, а выполнившие снова занимали бы
-- места.
INSERT INTO "task_participant" ("task_id", "account_id", "completed_at")
SELECT p."task_id", p."account_id", min(p."completed_at")
FROM "task_progress" p JOIN "task_def" d ON d."task_id" = p."task_id"
WHERE d."params" IS NOT NULL AND p."completed_at" IS NOT NULL
GROUP BY p."task_id", p."account_id";

UPDATE "task_def" d SET "completions" = c."count"
FROM (SELECT "task_id", count(*)::int AS "count" FROM "task_participant" GROUP BY "task_id") c
WHERE c."task_id" = d."task_id";
