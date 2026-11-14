-- Кодекс врагов (docs/39-retention-mechanics.md К2, docs/35-stage4-plan.md Р102,
-- tasks/T-0127). Только добавление: таблица открытых записей и три строки каталога
-- заданий; существующие строки и прогресс не меняются.
--
-- Запись открывается, когда игрок встретил врага в забеге, и не закрывается.
-- Список врагов — таблица сервера (`CODEX_ENEMY_IDS`), внешнего ключа на врага нет.

-- CreateTable
CREATE TABLE "codex_entry" (
    "account_id" UUID NOT NULL,
    "enemy_id" VARCHAR(48) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "codex_entry_pkey" PRIMARY KEY ("account_id","enemy_id")
);

-- AddForeignKey
ALTER TABLE "codex_entry" ADD CONSTRAINT "codex_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Награда за кодекс — три достижения лестницы `codex`: цель в процентах открытого
-- кодекса (список врагов растёт с каждым поездом), вид `codex_percent` с действием
-- «максимум». Числа стартовые, геймдизайнер калибрует. Награда — монеты, без
-- самоцветов и осколков; `sort` — после достижений T-0106 (шаг 10, последнее — 480).
INSERT INTO "task_def" ("task_id", "period", "kind", "filter", "target", "title", "hint", "category", "ladder", "rung", "hidden", "prestige", "coins", "active", "sort", "created_at", "updated_at") VALUES
  ('ach_codex_30',  'achievement', 'codex_percent', NULL, 30,  'Первые наброски', NULL, 'collection', 'codex', 1, false, 5,  100, true, 500, now(), now()),
  ('ach_codex_60',  'achievement', 'codex_percent', NULL, 60,  'Знаток тварей',   NULL, 'collection', 'codex', 2, false, 10, 200, true, 510, now(), now()),
  ('ach_codex_100', 'achievement', 'codex_percent', NULL, 100, 'Полный кодекс',   NULL, 'collection', 'codex', 3, false, 20, 400, true, 520, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
