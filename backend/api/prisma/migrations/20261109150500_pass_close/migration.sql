-- Закрытие месяца батл-пасса (docs/35-stage4-plan.md Р46, tasks/T-0312): метка
-- «незабранное выдано всем». Пишется последней, поэтому упавшее посреди закрытие
-- повторяется целиком, а двойных выдач нет — их держат ключ кошелька и журнал
-- `pass_claim`. Только добавление: существующие таблицы не меняются.

-- CreateTable
CREATE TABLE "pass_close" (
    "month_key" VARCHAR(7) NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pass_close_pkey" PRIMARY KEY ("month_key")
);

-- Ограничения формата

ALTER TABLE "pass_close" ADD CONSTRAINT "pass_close_month_key_check" CHECK ("month_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
