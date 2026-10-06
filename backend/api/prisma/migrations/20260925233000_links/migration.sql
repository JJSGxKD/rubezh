-- CreateTable
CREATE TABLE "link" (
    "code" VARCHAR(16) NOT NULL,
    "platform" "Platform" NOT NULL DEFAULT 'telegram',
    "campaign" VARCHAR(64) NOT NULL,
    "source" VARCHAR(64),
    "medium" VARCHAR(64),
    "note" VARCHAR(200),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "link_click" (
    "click_id" VARCHAR(16) NOT NULL,
    "link_code" VARCHAR(16) NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "utm_source" VARCHAR(128),
    "utm_medium" VARCHAR(128),
    "utm_campaign" VARCHAR(128),
    "utm_content" VARCHAR(128),
    "utm_term" VARCHAR(128),
    "referer_host" VARCHAR(255),
    "device_class" VARCHAR(16),
    "ip_prefix" VARCHAR(64),
    "language" VARCHAR(16),

    CONSTRAINT "link_click_pkey" PRIMARY KEY ("click_id")
);

-- CreateIndex
CREATE INDEX "link_created_at_idx" ON "link"("created_at");

-- CreateIndex
CREATE INDEX "link_click_link_code_at_idx" ON "link_click"("link_code", "at");

-- AddForeignKey
ALTER TABLE "link_click" ADD CONSTRAINT "link_click_link_code_fkey" FOREIGN KEY ("link_code") REFERENCES "link"("code") ON DELETE CASCADE ON UPDATE CASCADE;

