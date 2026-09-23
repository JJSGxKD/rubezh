-- CreateTable
CREATE TABLE "account" (
    "account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "platform_user_id" VARCHAR(32) NOT NULL,
    "display_name" VARCHAR(128) NOT NULL,
    "username" VARCHAR(64),
    "photo_url" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "banned_at" TIMESTAMPTZ(3),
    "ban_reason" VARCHAR(256),

    CONSTRAINT "account_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "account_last_seen_at_idx" ON "account"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "account_platform_platform_user_id_key" ON "account"("platform", "platform_user_id");
