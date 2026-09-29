-- AlterTable
ALTER TABLE "item" ADD COLUMN     "seen_at" TIMESTAMPTZ(3);

-- То, что уже лежит в инвентаре, игрок видел: иначе после выката знак на
-- арсенале загорелся бы у всех разом числом всего инвентаря.
UPDATE "item" SET "seen_at" = "created_at" WHERE "seen_at" IS NULL;
