-- Ограничения игрока (docs/35-stage4-plan.md Р75, WP44): закрыть часть
-- функций на срок, а не блокировать целиком. Блокировка целиком — вид `all`.
CREATE TABLE "account_restriction" (
    "restriction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "reason" VARCHAR(32) NOT NULL,
    "comment" VARCHAR(500),
    "notify" BOOLEAN NOT NULL,
    "imposed_by" UUID,
    "lifted_at" TIMESTAMPTZ(3),
    "lifted_by" UUID,
    "lift_comment" VARCHAR(500),
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "account_restriction_pkey" PRIMARY KEY ("restriction_id")
);

-- Карточка игрока в панели — история новыми сверху; проверка «действует ли»
-- читает те же строки аккаунта.
CREATE INDEX "account_restriction_account_id_starts_at_idx" ON "account_restriction"("account_id", "starts_at" DESC);

-- Задача по сроку ищет только то, чьи последствия ещё не сняты: таких строк
-- единицы, а не вся история.
CREATE INDEX "account_restriction_unsettled_idx" ON "account_restriction"("ends_at") WHERE "settled_at" IS NULL;

ALTER TABLE "account_restriction" ADD CONSTRAINT "account_restriction_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_restriction" ADD CONSTRAINT "account_restriction_kind_check" CHECK ("kind" ~ '^[a-z_]{2,32}$');
ALTER TABLE "account_restriction" ADD CONSTRAINT "account_restriction_term_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "account_restriction" ADD CONSTRAINT "account_restriction_lift_check" CHECK (("lifted_at" IS NULL) = ("lift_comment" IS NULL));
-- Молча блокировать целиком нельзя: игрок всё равно увидит отказ при входе.
ALTER TABLE "account_restriction" ADD CONSTRAINT "account_restriction_all_notify_check" CHECK ("kind" <> 'all' OR "notify");

-- Нынешние блокировки — строками вида `all`, бессрочными: история
-- ограничений игрока начинается с них, а снятие идёт тем же путём.
INSERT INTO "account_restriction" ("restriction_id", "account_id", "kind", "starts_at", "reason", "comment", "notify")
SELECT gen_random_uuid(), "account_id", 'all', "banned_at", 'other', "ban_reason", true
FROM "account" WHERE "banned_at" IS NOT NULL;
