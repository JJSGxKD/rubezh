-- CreateTable
CREATE TABLE "outbound_call" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "service" VARCHAR(32) NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "host" VARCHAR(128) NOT NULL,
    "path" VARCHAR(256) NOT NULL,
    "status" SMALLINT,
    "ok" BOOLEAN NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "via" VARCHAR(40) NOT NULL,
    "attempt" SMALLINT NOT NULL,
    "error" VARCHAR(16),

    CONSTRAINT "outbound_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_minute" (
    "minute" TIMESTAMPTZ(0) NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "route" VARCHAR(160) NOT NULL,
    "status_class" VARCHAR(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "buckets" INTEGER[],

    CONSTRAINT "inbound_minute_pkey" PRIMARY KEY ("minute","method","route","status_class")
);

-- CreateIndex
CREATE INDEX "outbound_call_at_idx" ON "outbound_call"("at" DESC);

-- CreateIndex
CREATE INDEX "outbound_call_service_at_idx" ON "outbound_call"("service", "at" DESC);

-- CreateIndex
CREATE INDEX "inbound_minute_route_minute_idx" ON "inbound_minute"("route", "minute" DESC);
