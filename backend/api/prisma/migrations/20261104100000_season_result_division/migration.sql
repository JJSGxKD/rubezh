-- Дивизион сезона по доле доски (T-0295): пишется при закрытии, сезоны до задачи остаются без него.
-- AlterTable
ALTER TABLE "season_result" ADD COLUMN     "division" VARCHAR(8);
