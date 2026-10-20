-- Только добавление (expand): два необязательных столбца, без значений по умолчанию и без переписывания строк.
-- Откат: ALTER TABLE "account" DROP COLUMN "platform_name", DROP COLUMN "name_locked_at";

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "name_locked_at" TIMESTAMPTZ(3),
ADD COLUMN     "platform_name" VARCHAR(256);
