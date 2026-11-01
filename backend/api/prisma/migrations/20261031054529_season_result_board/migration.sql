-- Награды сезона по доске зрителя (T-0114, Р104): итог аккаунта считается в таблице
-- его доски на момент закрытия — общей (без аккаунтов со скрытым ограничением
-- «Отдельная доска») или полной. Строки, закрытые до этой миграции, — общие.
ALTER TABLE "season_result" ADD COLUMN "board" VARCHAR(8) NOT NULL DEFAULT 'common';

ALTER TABLE "season_result" ADD CONSTRAINT "season_result_board_check" CHECK ("board" IN ('common', 'full'));
