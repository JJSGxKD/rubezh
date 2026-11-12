-- Решение разбора забега (Р203, T-0419): `honest` или `annulled`, когда и кто решил.
-- Только расширение: три пустые колонки без значения по умолчанию, таблица не
-- переписывается, у прежних забегов решения нет.

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "review_outcome" VARCHAR(16),
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID;
