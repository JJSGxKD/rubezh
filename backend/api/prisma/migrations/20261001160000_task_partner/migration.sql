-- Партнёрские цели (Р52): к подписке на канал добавились переход по ссылке и
-- запуск бота. Параметры — ровно у партнёрских целей, как и раньше у канала.
ALTER TABLE "task_def" DROP CONSTRAINT "task_def_params_check";
ALTER TABLE "task_def" ADD CONSTRAINT "task_def_params_check" CHECK (("kind" IN ('channel', 'link', 'bot')) = ("params" IS NOT NULL));
