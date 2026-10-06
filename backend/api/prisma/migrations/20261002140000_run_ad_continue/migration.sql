-- Второй шанс за рекламу (docs/35-stage4-plan.md WP11, Р4): продолжение
-- забега по сессии показа места second_chance — досмотренной или пропуску
-- VIP. Вторая книга продолжений рядом с покупками: итог забега сверяется с
-- обеими, а один номер продолжения не выдаётся двумя способами.
CREATE TABLE "run_ad_continue" (
    "run_id" VARCHAR(64) NOT NULL,
    "continue_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "session_id" VARCHAR(32) NOT NULL,
    "network_key" VARCHAR(32) NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_ad_continue_pkey" PRIMARY KEY ("run_id","continue_no"),
    CONSTRAINT "run_ad_continue_continue_no_check" CHECK ("continue_no" >= 1)
);

CREATE UNIQUE INDEX "run_ad_continue_session_id_key" ON "run_ad_continue"("session_id");

-- Суточный потолок рекламных продолжений игрока.
CREATE INDEX "run_ad_continue_account_id_granted_at_idx" ON "run_ad_continue"("account_id", "granted_at");

ALTER TABLE "run_ad_continue" ADD CONSTRAINT "run_ad_continue_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_ad_continue" ADD CONSTRAINT "run_ad_continue_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
