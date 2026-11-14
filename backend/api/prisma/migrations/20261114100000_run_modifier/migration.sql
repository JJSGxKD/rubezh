-- Модификатор забега (docs/35-stage4-plan.md Р105, tasks/T-0122): один на
-- забег; `null` — забег без него. Без индекса: фильтра по колонке нет.

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "modifier_id" TEXT;
