-- Серия дней (docs/35-stage4-plan.md Р154, tasks/T-0262): ступень серии
-- лежит в строке награды дня. Ноль у тех, кто серии ещё не копил; потолок
-- десять ступеней (+50 %) держит и код, и ограничение.

-- AlterTable
ALTER TABLE "daily_reward" ADD COLUMN "streak" SMALLINT NOT NULL DEFAULT 0;

-- AddCheck
ALTER TABLE "daily_reward" ADD CONSTRAINT "daily_reward_streak_check" CHECK ("streak" BETWEEN 0 AND 10);
