-- Вайп стирает забеги (docs/35-stage4-plan.md Р87), а покупка второго шанса остаётся:
-- ссылка на забег обнуляется, звёзды, номер продолжения и оплата сохраняются.

-- DropForeignKey
ALTER TABLE "purchase" DROP CONSTRAINT "purchase_run_id_fkey";

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Обнуление ссылки — это UPDATE строки покупки, и прежняя проверка (второй шанс обязан
-- ссылаться на забег) его не пропускала: стирание забега падало. Забег по-прежнему
-- обязателен при создании счёта — это держит код (`openInvoice`); в базе остаётся
-- проверка того, что продолжение и секунда цены заданы ровно у второго шанса.
ALTER TABLE "purchase" DROP CONSTRAINT "purchase_continue_check";
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_continue_check" CHECK (
  ("product" = 'continue_run') = ("continue_no" IS NOT NULL AND "elapsed_sec" IS NOT NULL)
);
