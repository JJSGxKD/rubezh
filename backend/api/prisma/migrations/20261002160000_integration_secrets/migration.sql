-- Ключи интеграций (docs/35-stage4-plan.md WP46, Р84): токены внешних
-- сервисов из панели — только шифртекстом AES-256-GCM. Длины IV и подписи
-- держит база: строка, записанная в обход панели не тем шифром, не
-- сохранится.
CREATE TABLE "integration_secret" (
    "key" VARCHAR(64) NOT NULL,
    "key_id" VARCHAR(16) NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_secret_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "integration_secret_iv_check" CHECK (octet_length("iv") = 12),
    CONSTRAINT "integration_secret_auth_tag_check" CHECK (octet_length("auth_tag") = 16),
    CONSTRAINT "integration_secret_ciphertext_check" CHECK (octet_length("ciphertext") BETWEEN 1 AND 2048)
);
