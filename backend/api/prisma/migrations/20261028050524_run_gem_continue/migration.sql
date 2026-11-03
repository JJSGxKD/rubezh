-- Второй шанс за самоцветы (docs/35-stage4-plan.md Р162, tasks/T-0324):
-- продолжение забега, купленное в игровой валюте. Третья книга продолжений
-- рядом с покупками за звёзды и рекламой. Только добавление (expand): новая
-- таблица, старый код её не читает и не пишет.
-- Откат: DROP TABLE "run_gem_continue" — после того как выкачен код без
-- модуля; списания самоцветов остаются в журнале кошелька (причина continue).
CREATE TABLE "run_gem_continue" (
    "run_id" VARCHAR(64) NOT NULL,
    "continue_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "elapsed_sec" DOUBLE PRECISION NOT NULL,
    "price_gems" INTEGER NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_gem_continue_pkey" PRIMARY KEY ("run_id","continue_no"),
    CONSTRAINT "run_gem_continue_continue_no_check" CHECK ("continue_no" >= 1),
    CONSTRAINT "run_gem_continue_price_gems_check" CHECK ("price_gems" > 0),
    CONSTRAINT "run_gem_continue_elapsed_sec_check" CHECK ("elapsed_sec" >= 0)
);

-- Продолжения игрока по времени: каскад с аккаунта и разбор покупок.
CREATE INDEX "run_gem_continue_account_id_granted_at_idx" ON "run_gem_continue"("account_id", "granted_at");

ALTER TABLE "run_gem_continue" ADD CONSTRAINT "run_gem_continue_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_gem_continue" ADD CONSTRAINT "run_gem_continue_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
