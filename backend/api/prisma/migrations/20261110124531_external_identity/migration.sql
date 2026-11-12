-- Связь аккаунта игры с аккаунтом MAX или VK (docs/35-stage4-plan.md Р188, tasks/T-0377):
-- по ней сервер проверяет подписку на канал другой площадки. Только добавление: существующие
-- таблицы не меняются, откат кода безопасен.
--
-- Связь постоянная: пара «площадка + id» принадлежит одному аккаунту (уникальный индекс), у
-- аккаунта на площадке одна связь (первичный ключ). Площадку держит `CHECK`: связи бывают
-- только с MAX и VK, а вход по ним — не эта таблица.

-- CreateTable
CREATE TABLE "external_identity" (
    "account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_user_id" VARCHAR(64) NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identity_pkey" PRIMARY KEY ("account_id","platform")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_identity_platform_external_user_id_key" ON "external_identity"("platform", "external_user_id");

-- AddForeignKey
ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ограничения формата

ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_platform_check" CHECK ("platform" IN ('max', 'vk'));
ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_external_user_id_check" CHECK (length("external_user_id") > 0);
