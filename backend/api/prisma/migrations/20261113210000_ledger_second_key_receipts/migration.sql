-- AlterTable
ALTER TABLE "media_image" ADD COLUMN     "view_permission" VARCHAR(64);

-- AlterTable
ALTER TABLE "ledger_operation" ADD COLUMN     "receipt_image" CHAR(64);

-- Правило, которое схема Prisma не выражает: снимок чека — это id картинки (SHA-256 в hex), а не произвольная строка
ALTER TABLE "ledger_operation" ADD CONSTRAINT "ledger_operation_receipt_image_check" CHECK ("receipt_image" IS NULL OR "receipt_image" ~ '^[0-9a-f]{64}$');
