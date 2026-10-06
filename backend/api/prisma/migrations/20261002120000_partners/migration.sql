-- Партнёры и их коды (docs/35-stage4-plan.md WP41, часть 2;
-- docs/23-referral-and-partner-program.md §3, §5): блогер или канал, его
-- промокоды и игроки, которых он привёл. Слот источника у игрока один —
-- реферер или партнёр, кто первый; это держит сервис под блокировкой
-- аккаунта (`attribution/source-slot.ts`).

-- CreateTable
CREATE TABLE "partner" (
    "partner_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "contact" VARCHAR(120),
    "note" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_pkey" PRIMARY KEY ("partner_id")
);

-- CreateTable
CREATE TABLE "partner_binding" (
    "account_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "campaign_id" UUID,
    "bound_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_binding_pkey" PRIMARY KEY ("account_id")
);

-- AlterTable
ALTER TABLE "promo_campaign" ADD COLUMN "partner_id" UUID;

-- CreateIndex
CREATE INDEX "partner_created_at_idx" ON "partner"("created_at");

-- CreateIndex
CREATE INDEX "partner_binding_partner_id_bound_at_idx" ON "partner_binding"("partner_id", "bound_at");

-- CreateIndex
CREATE INDEX "partner_binding_campaign_id_idx" ON "partner_binding"("campaign_id");

-- CreateIndex
CREATE INDEX "promo_campaign_partner_id_idx" ON "promo_campaign"("partner_id");

-- AddForeignKey
ALTER TABLE "partner_binding" ADD CONSTRAINT "partner_binding_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Партнёра с приведёнными игроками и кодами не удалить: по ним считаются его игроки.
-- AddForeignKey
ALTER TABLE "partner_binding" ADD CONSTRAINT "partner_binding_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("partner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_binding" ADD CONSTRAINT "partner_binding_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promo_campaign"("campaign_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_campaign" ADD CONSTRAINT "promo_campaign_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("partner_id") ON DELETE RESTRICT ON UPDATE CASCADE;
