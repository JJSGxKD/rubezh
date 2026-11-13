-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('asset', 'revenue', 'expense', 'liability', 'equity');

-- CreateTable
CREATE TABLE "ledger_account" (
    "account_id" VARCHAR(64) NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "ledger_account_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "entry_id" UUID NOT NULL,
    "source_key" VARCHAR(128) NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "period" CHAR(7) NOT NULL,
    "memo" VARCHAR(500) NOT NULL,
    "reversal_of" UUID,
    "meta" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "ledger_line" (
    "line_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "ledger_line_pkey" PRIMARY KEY ("line_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_source_key_key" ON "ledger_entry"("source_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_reversal_of_key" ON "ledger_entry"("reversal_of");

-- CreateIndex
CREATE INDEX "ledger_entry_period_idx" ON "ledger_entry"("period");

-- CreateIndex
CREATE INDEX "ledger_entry_at_idx" ON "ledger_entry"("at");

-- CreateIndex
CREATE INDEX "ledger_line_account_id_entry_id_idx" ON "ledger_line"("account_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_line_entry_id_account_id_key" ON "ledger_line"("entry_id", "account_id");

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reversal_of_fkey" FOREIGN KEY ("reversal_of") REFERENCES "ledger_entry"("entry_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entry"("entry_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Строка с нулём в журнале бессмысленна и скрывает ошибку источника; период — «ГГГГ-ММ» по UTC (Р219)
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_amount_check" CHECK ("amount" <> 0);
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Журнал не правится и не удаляется: исправление — сторно (docs/37-accounting.md §2). Триггеры стоят на записи
-- и строках, и на TRUNCATE: прямой запрос обходит код, но не базу.
CREATE FUNCTION "ledger_journal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Журнал учёта не правится — исправление сторно';
END;
$$;

CREATE TRIGGER "ledger_entry_immutable" BEFORE UPDATE OR DELETE ON "ledger_entry"
    FOR EACH ROW EXECUTE FUNCTION "ledger_journal_guard"();
CREATE TRIGGER "ledger_line_immutable" BEFORE UPDATE OR DELETE ON "ledger_line"
    FOR EACH ROW EXECUTE FUNCTION "ledger_journal_guard"();
CREATE TRIGGER "ledger_entry_no_truncate" BEFORE TRUNCATE ON "ledger_entry"
    FOR EACH STATEMENT EXECUTE FUNCTION "ledger_journal_guard"();
CREATE TRIGGER "ledger_line_no_truncate" BEFORE TRUNCATE ON "ledger_line"
    FOR EACH STATEMENT EXECUTE FUNCTION "ledger_journal_guard"();

-- Начальный план счетов (Р219): места хранения и статьи выручки Telegram. Статьи расходов, обязательств и
-- капитала заводятся в панели. Время создания растёт на миллисекунду, чтобы панель показывала счета в этом порядке.
INSERT INTO "ledger_account" ("account_id", "type", "currency", "name", "created_at") VALUES
    ('stars.bot.hold', 'asset', 'XTR', 'Звёзды бота — в холде', CURRENT_TIMESTAMP + INTERVAL '1 millisecond'),
    ('stars.bot.available', 'asset', 'XTR', 'Звёзды бота — доступно', CURRENT_TIMESTAMP + INTERVAL '2 millisecond'),
    ('wallet.ton', 'asset', 'GRAM', 'Кошелёк TON', CURRENT_TIMESTAMP + INTERVAL '3 millisecond'),
    ('exchange.usdt', 'asset', 'USDT', 'Биржа или USDT', CURRENT_TIMESTAMP + INTERVAL '4 millisecond'),
    ('bank.rub', 'asset', 'RUB', 'Банк, ₽', CURRENT_TIMESTAMP + INTERVAL '5 millisecond'),
    ('revenue.shop.telegram', 'revenue', 'XTR', 'Выручка: магазин, Telegram', CURRENT_TIMESTAMP + INTERVAL '6 millisecond'),
    ('revenue.continue.telegram', 'revenue', 'XTR', 'Выручка: второй шанс, Telegram', CURRENT_TIMESTAMP + INTERVAL '7 millisecond'),
    ('revenue.vip.telegram', 'revenue', 'XTR', 'Выручка: VIP, Telegram', CURRENT_TIMESTAMP + INTERVAL '8 millisecond'),
    ('revenue.donation.telegram', 'revenue', 'XTR', 'Донаты, Telegram', CURRENT_TIMESTAMP + INTERVAL '9 millisecond');

