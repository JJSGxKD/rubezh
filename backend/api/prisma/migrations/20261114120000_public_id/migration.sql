-- Публичный id игрока (docs/35-stage4-plan.md Р47, tasks/T-0247): 12 шестнадцатеричных знаков,
-- уникальный, не меняется. Внутренний account_id наружу не уходит, по публичному id открывается
-- карточка игрока и зовут в друзья. Столбец появляется сразу NOT NULL с запасным значением:
-- существующим аккаунтам оно считается построчно (volatile default), а вставка мимо репозитория
-- не остаётся без id.

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "public_id" VARCHAR(12) NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 12);

-- CreateIndex
CREATE UNIQUE INDEX "account_public_id_key" ON "account"("public_id");
