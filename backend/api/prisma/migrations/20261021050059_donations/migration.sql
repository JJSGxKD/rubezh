-- Донаты проекту (docs/35-stage4-plan.md, Р109): вид покупки и знак «Поддержал проект».
-- Новое значение перечисления в этой же миграции не используется: Postgres не даёт
-- применить его в той же транзакции, где оно добавлено.

-- AlterEnum
ALTER TYPE "PurchaseProduct" ADD VALUE 'donation';

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "supporter_at" TIMESTAMPTZ(3);
