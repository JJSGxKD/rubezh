-- Отметки удержания подписки (docs/35-stage4-plan.md Р139, tasks/T-0223): был ли
-- игрок в канале на 1-й, 3-й и 7-й день после награды. Пусто — не известно:
-- проверка ещё не дошла до срока или площадка не ответила. Старые окна остаются
-- без отметок. Откат — DROP COLUMN.

ALTER TABLE "task_channel_watch" ADD COLUMN "held_d1" BOOLEAN;
ALTER TABLE "task_channel_watch" ADD COLUMN "held_d3" BOOLEAN;
ALTER TABLE "task_channel_watch" ADD COLUMN "held_d7" BOOLEAN;
