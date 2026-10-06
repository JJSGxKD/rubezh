-- CreateEnum
CREATE TYPE "ItemSlot" AS ENUM ('weapon', 'amulet', 'gloves', 'armor', 'belt', 'boots');

-- CreateEnum
CREATE TYPE "ItemRarity" AS ENUM ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic');

-- CreateTable
CREATE TABLE "item" (
    "item_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "slot" "ItemSlot" NOT NULL,
    "rarity" "ItemRarity" NOT NULL,
    "level" INTEGER NOT NULL,
    "seed" BIGINT NOT NULL,
    "rolls" JSONB NOT NULL,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "source" VARCHAR(96) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "item_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "item_event" (
    "event_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "item_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "item_account_id_removed_at_idx" ON "item"("account_id", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "item_event_idempotency_key_key" ON "item_event"("idempotency_key");

-- CreateIndex
CREATE INDEX "item_event_account_id_created_at_idx" ON "item_event"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_event" ADD CONSTRAINT "item_event_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_event" ADD CONSTRAINT "item_event_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Надетый предмет в слоте у аккаунта — один. Частичный индекс: Prisma его не
-- описывает, поэтому он только здесь. Две параллельные «надеть» в один слот
-- упрутся в него, а не оставят два надетых.
CREATE UNIQUE INDEX "item_equipped_slot_key" ON "item"("account_id", "slot") WHERE "equipped" AND "removed_at" IS NULL;
