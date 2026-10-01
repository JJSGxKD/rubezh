-- AlterTable
ALTER TABLE "task_def" ADD COLUMN "params" JSONB;

-- Параметры — ровно у цели «канал»: её нечем проверить без канала, а у цели
-- забега параметры ничего бы не значили. Схема самих параметров — в коде.
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_params_check" CHECK (("kind" = 'channel') = ("params" IS NOT NULL));
