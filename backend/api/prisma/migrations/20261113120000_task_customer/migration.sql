-- Заказчик партнёрского задания (docs/35-stage4-plan.md Р138, Р139): кто
-- платит, по какой модели и сколько, и сколько суток игрок должен
-- продержаться, чтобы выполнение оплачивалось. Только для команды и отчёта.

-- Заказчик — строка; пусто — задание своё, не продаётся.
ALTER TABLE "task_def" ADD COLUMN "customer" VARCHAR(80);
-- Модель оплаты: cpa — за выполнение, rs — доля дохода.
ALTER TABLE "task_def" ADD COLUMN "pay_model" VARCHAR(8);
-- Ставка: у cpa — центы доллара за выполнение, у rs — сотые доли процента.
ALTER TABLE "task_def" ADD COLUMN "rate" INTEGER;
-- Через сколько суток удержания выполнение оплачивается; 0 — сразу.
ALTER TABLE "task_def" ADD COLUMN "hold_days" SMALLINT NOT NULL DEFAULT 0;

-- Модель — вместе с заказчиком, ставка — вместе с моделью.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_customer_pay_check" CHECK (("pay_model" IS NULL) = ("customer" IS NULL));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_rate_pay_check" CHECK (("rate" IS NULL) = ("pay_model" IS NULL));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_pay_model_check" CHECK ("pay_model" IS NULL OR "pay_model" IN ('cpa', 'rs'));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_rate_range_check" CHECK ("rate" IS NULL OR ("pay_model" = 'cpa' AND "rate" BETWEEN 1 AND 100000) OR ("pay_model" = 'rs' AND "rate" BETWEEN 1 AND 10000));
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_hold_days_check" CHECK ("hold_days" IN (0, 1, 3, 7));
-- Заказчик и удержание — только у партнёрской цели: у цели забега продавать нечего.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_customer_kind_check" CHECK (("customer" IS NULL AND "hold_days" = 0) OR "params" IS NOT NULL);
