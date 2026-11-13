-- Заявки на правку с подтверждением второго участника (tasks/T-0309, docs/19-content-admin.md §6)
-- и правки товаров магазина поверх каталога в коде. Только новые таблицы: код прошлого релиза
-- на такой схеме работает.

-- CreateTable
CREATE TABLE "change_request" (
    "request_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "target" VARCHAR(64) NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "author" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "change_request_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "shop_sku_override" (
    "sku_id" VARCHAR(32) NOT NULL,
    "fields" JSONB NOT NULL,
    "set_by" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_sku_override_pkey" PRIMARY KEY ("sku_id")
);

-- CreateIndex
CREATE INDEX "change_request_created_at_idx" ON "change_request"("created_at");

-- CreateIndex
CREATE INDEX "change_request_kind_target_status_idx" ON "change_request"("kind", "target", "status");

-- Вид и статус — из списка: опечатка в коде не должна стать третьим значением, которое панель
-- не умеет показать. `reward_setting` — награды (T-0310): вид заведён заранее, чтобы та задача
-- не меняла схему.
ALTER TABLE "change_request" ADD CONSTRAINT "change_request_kind_check" CHECK ("kind" IN ('sku_price', 'reward_setting'));
ALTER TABLE "change_request" ADD CONSTRAINT "change_request_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'superseded'));

-- Одна живая заявка на цель: новая гасит прежнюю в той же транзакции, а гонка двух заявок под
-- блокировкой цели не оставит две. Закрытых заявок на цель сколько угодно.
CREATE UNIQUE INDEX "change_request_pending_key" ON "change_request"("kind", "target") WHERE "status" = 'pending';
