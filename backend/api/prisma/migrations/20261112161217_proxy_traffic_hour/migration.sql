-- CreateTable
CREATE TABLE "proxy_traffic_hour" (
    "hour" TIMESTAMPTZ(0) NOT NULL,
    "subscription_key" VARCHAR(16) NOT NULL,
    "node_key" VARCHAR(16) NOT NULL,
    "node_name" VARCHAR(80) NOT NULL,
    "up_bytes" BIGINT NOT NULL,
    "down_bytes" BIGINT NOT NULL,

    CONSTRAINT "proxy_traffic_hour_pkey" PRIMARY KEY ("hour","subscription_key","node_key")
);

-- Час — граница часа по UTC (не по часовому поясу сессии), байты не отрицательны:
-- чтение Xray со сбросом даёт только прибавки.
ALTER TABLE "proxy_traffic_hour"
  ADD CONSTRAINT "proxy_traffic_hour_hour_check" CHECK (("hour" AT TIME ZONE 'UTC') = date_trunc('hour', "hour" AT TIME ZONE 'UTC')),
  ADD CONSTRAINT "proxy_traffic_hour_bytes_check" CHECK ("up_bytes" >= 0 AND "down_bytes" >= 0);
