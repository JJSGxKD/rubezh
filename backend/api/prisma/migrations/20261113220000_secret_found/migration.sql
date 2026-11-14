-- Кодекс тайников (docs/35-stage4-plan.md Р153, design/art/meta-v2.md §5.3,
-- tasks/T-0261). Только добавление: таблица найденных видов и одна строка каталога
-- достижений; существующие строки и прогресс не меняются.
--
-- Вид считается найденным, когда игрок нашёл тайник в забеге, который считается
-- по правилам наград, и не закрывается. Виды — список движка (`SECRET_KINDS`),
-- внешнего ключа на вид нет.

-- CreateTable
CREATE TABLE "secret_found" (
    "account_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "first_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "secret_found_pkey" PRIMARY KEY ("account_id","kind")
);

-- AddForeignKey
ALTER TABLE "secret_found" ADD CONSTRAINT "secret_found_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- «Следопыт» — все шесть видов: цель в числе найденных видов, вид `secrets_kinds`
-- с действием «максимум». Знак у имени редкости `epic` (T-0235). Награда — монеты,
-- без самоцветов и осколков, по меркам достижений с тем же престижем (`ach_account_50`,
-- `ach_friends_25`); числа стартовые, геймдизайнер калибрует. `sort` — после трёх
-- достижений кодекса врагов (500…520), до статусных знаков (с 900).
INSERT INTO "task_def" ("task_id", "period", "kind", "filter", "target", "title", "hint", "category", "ladder", "rung", "hidden", "prestige", "coins", "emblem_tier", "active", "sort", "created_at", "updated_at") VALUES
  ('ach_secrets_all', 'achievement', 'secrets_kinds', NULL, 6, 'Следопыт', NULL, 'collection', 'secrets', 1, false, 40, 800, 'epic', true, 530, now(), now())
ON CONFLICT ("task_id") DO NOTHING;
