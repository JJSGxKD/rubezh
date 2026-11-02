-- CreateTable
CREATE TABLE "proxy_subscription" (
    "key" VARCHAR(16) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "url_iv" BYTEA NOT NULL,
    "url_tag" BYTEA NOT NULL,
    "url_ct" BYTEA NOT NULL,
    "url_key_id" VARCHAR(16) NOT NULL,
    "url_hint" VARCHAR(80) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "countries" VARCHAR(2)[],
    "last_refresh_at" TIMESTAMPTZ(3),
    "last_refresh_ok" BOOLEAN,
    "last_refresh_note" VARCHAR(300),
    "provider_interval_hours" INTEGER,
    "traffic_used_bytes" BIGINT,
    "traffic_total_bytes" BIGINT,
    "expires_at" TIMESTAMPTZ(3),
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proxy_subscription_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "proxy_subscription_node" (
    "subscription_key" VARCHAR(16) NOT NULL,
    "node_key" VARCHAR(16) NOT NULL,
    "slot" INTEGER NOT NULL,
    "protocol" VARCHAR(12) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "country" VARCHAR(2),
    "host" VARCHAR(255) NOT NULL,
    "state" VARCHAR(8) NOT NULL,
    "failures" INTEGER NOT NULL,
    "latency_ms" INTEGER,
    "last_probe_at" TIMESTAMPTZ(3),
    "next_probe_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proxy_subscription_node_pkey" PRIMARY KEY ("subscription_key","node_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "proxy_subscription_node_slot_key" ON "proxy_subscription_node"("slot");

-- AddForeignKey
ALTER TABLE "proxy_subscription_node" ADD CONSTRAINT "proxy_subscription_node_subscription_key_fkey" FOREIGN KEY ("subscription_key") REFERENCES "proxy_subscription"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- Одна подписка на систему; состояние узла, слот и страна — из перечня.
ALTER TABLE "proxy_subscription"
  ADD CONSTRAINT "proxy_subscription_key_check" CHECK ("key" = 'main');

ALTER TABLE "proxy_subscription_node"
  ADD CONSTRAINT "proxy_subscription_node_state_check" CHECK ("state" IN ('unknown', 'healthy', 'down')),
  ADD CONSTRAINT "proxy_subscription_node_slot_check" CHECK ("slot" >= 0),
  ADD CONSTRAINT "proxy_subscription_node_failures_check" CHECK ("failures" >= 0),
  ADD CONSTRAINT "proxy_subscription_node_country_check" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

