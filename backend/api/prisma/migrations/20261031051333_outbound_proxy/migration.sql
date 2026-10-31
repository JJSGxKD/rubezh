-- Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, tasks/T-0065):
-- список в панели и режим каждого сервиса клиента исходящих. Пароль прокси —
-- только шифртекстом AES-256-GCM, как ключи интеграций: четыре колонки пароля
-- заполнены все или не заполнена ни одна, длины IV и подписи держит база.

-- CreateTable
CREATE TABLE "outbound_proxy" (
    "proxy_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "scheme" VARCHAR(8) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "username" VARCHAR(128),
    "password_iv" BYTEA,
    "password_tag" BYTEA,
    "password_ct" BYTEA,
    "password_key_id" VARCHAR(16),
    "country" VARCHAR(2) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "priority" INTEGER NOT NULL,
    "note" VARCHAR(200),
    "last_check_at" TIMESTAMPTZ(3),
    "last_check_ok" BOOLEAN,
    "last_check_note" VARCHAR(200),
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbound_proxy_pkey" PRIMARY KEY ("proxy_id"),
    CONSTRAINT "outbound_proxy_scheme_check" CHECK ("scheme" IN ('http', 'https', 'socks5')),
    CONSTRAINT "outbound_proxy_port_check" CHECK ("port" BETWEEN 1 AND 65535),
    CONSTRAINT "outbound_proxy_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
    CONSTRAINT "outbound_proxy_password_check" CHECK (
        ("password_iv" IS NULL AND "password_tag" IS NULL AND "password_ct" IS NULL AND "password_key_id" IS NULL)
        OR (
            octet_length("password_iv") = 12
            AND octet_length("password_tag") = 16
            AND octet_length("password_ct") BETWEEN 1 AND 2048
            AND "password_key_id" IS NOT NULL
        )
    )
);

-- CreateTable
CREATE TABLE "outbound_service_mode" (
    "service" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbound_service_mode_pkey" PRIMARY KEY ("service"),
    CONSTRAINT "outbound_service_mode_mode_check" CHECK ("mode" IN ('direct_first', 'proxy_only', 'direct_only'))
);

-- CreateIndex
CREATE INDEX "outbound_proxy_enabled_priority_idx" ON "outbound_proxy"("enabled", "priority");
