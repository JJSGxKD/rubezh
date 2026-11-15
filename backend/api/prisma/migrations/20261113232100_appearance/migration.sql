-- Облики-архетипы (docs/35-stage4-plan.md Р150, tasks/T-0237): выбранный облик героя и
-- выбор «голова облика или фото» в кружке аватара. Владение обликом в базе не хранится:
-- сервер считает его при чтении по уровню, VIP, достижению, ступени недели и месту в сезоне.

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "appearance_id" VARCHAR(24),
ADD COLUMN     "avatar_photo" BOOLEAN NOT NULL DEFAULT false;
