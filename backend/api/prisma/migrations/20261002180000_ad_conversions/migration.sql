-- Трекинг закупок рекламы (docs/35-stage4-plan.md WP43, Р86): ссылка
-- кампании знает сеть, где куплена реклама, клик хранит подставленные
-- сетью макросы, а конверсии игрока уходят в сеть постбэком — журналом и
-- очередью в одной таблице.
ALTER TABLE "link" ADD COLUMN "network" VARCHAR(16),
ADD COLUMN "registration_on" VARCHAR(16) NOT NULL DEFAULT 'first_run',
ADD CONSTRAINT "link_network_check" CHECK ("network" IS NULL OR "network" IN ('adsgram')),
ADD CONSTRAINT "link_registration_on_check" CHECK ("registration_on" IN ('first_run', 'launch'));

ALTER TABLE "link_click" ADD COLUMN "network_params" JSONB;

-- Макросы обнуляются, когда окно конверсии закрыто, — отбор только среди непустых.
CREATE INDEX "link_click_network_params_at_idx" ON "link_click"("at") WHERE "network_params" IS NOT NULL;

CREATE TYPE "ad_conversion_status" AS ENUM ('pending', 'sent', 'failed', 'skipped');

CREATE TABLE "ad_conversion" (
    "conversion_id" UUID NOT NULL,
    "network" VARCHAR(16) NOT NULL,
    "link_code" VARCHAR(16) NOT NULL,
    "click_id" VARCHAR(16) NOT NULL,
    "account_id" UUID NOT NULL,
    "goal" SMALLINT NOT NULL,
    "purchase_id" UUID,
    "status" "ad_conversion_status" NOT NULL DEFAULT 'pending',
    "reason" VARCHAR(32),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "http_status" SMALLINT,
    "last_error" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "ad_conversion_pkey" PRIMARY KEY ("conversion_id"),
    CONSTRAINT "ad_conversion_goal_check" CHECK ("goal" BETWEEN 1 AND 3),
    -- Регистрация — без оплаты, покупка — только с ней.
    CONSTRAINT "ad_conversion_purchase_check" CHECK (("goal" = 1) = ("purchase_id" IS NULL)),
    CONSTRAINT "ad_conversion_sent_check" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "ad_conversion_purchase_id_key" ON "ad_conversion"("purchase_id");

-- Регистрация и первая покупка — одна на клик: повторный проход не отправит их дважды.
CREATE UNIQUE INDEX "ad_conversion_click_id_goal_key" ON "ad_conversion"("click_id", "goal") WHERE "goal" IN (1, 2);

-- Очередь отправки.
CREATE INDEX "ad_conversion_status_next_attempt_at_idx" ON "ad_conversion"("status", "next_attempt_at");

-- Журнал ссылки.
CREATE INDEX "ad_conversion_link_code_created_at_idx" ON "ad_conversion"("link_code", "created_at");

ALTER TABLE "ad_conversion" ADD CONSTRAINT "ad_conversion_link_code_fkey" FOREIGN KEY ("link_code") REFERENCES "link"("code") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_conversion" ADD CONSTRAINT "ad_conversion_click_id_fkey" FOREIGN KEY ("click_id") REFERENCES "link_click"("click_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_conversion" ADD CONSTRAINT "ad_conversion_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_conversion" ADD CONSTRAINT "ad_conversion_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;
