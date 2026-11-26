-- CreateTable
CREATE TABLE "bot_card" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "chat_id" VARCHAR(32) NOT NULL,
    "message_id" INTEGER NOT NULL,
    "version" VARCHAR(16) NOT NULL,
    "period_key" VARCHAR(16),
    "state" TEXT NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "bot_card_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_card_platform_chat_id_message_id_idx" ON "bot_card"("platform", "chat_id", "message_id");

-- CreateIndex
CREATE INDEX "bot_card_kind_period_key_idx" ON "bot_card"("kind", "period_key");

-- AddForeignKey
ALTER TABLE "bot_card" ADD CONSTRAINT "bot_card_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Живая карточка вида у игрока одна. Частичный индекс: Prisma его не описывает,
-- поэтому он только здесь. Две отправки разом упрутся в него, а не оставят две
-- живые карточки; закрытые (`closed_at` задан) индексом не считаются.
CREATE UNIQUE INDEX "bot_card_live_key" ON "bot_card"("account_id", "kind") WHERE "closed_at" IS NULL;
