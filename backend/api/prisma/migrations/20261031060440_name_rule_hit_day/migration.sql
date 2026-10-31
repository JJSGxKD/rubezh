-- Суточные счётчики срабатываний правил фильтра имён (Р168, T-0340): сколько раз
-- правило изменило результат входа игрока за сутки UTC. Только id правила, сутки
-- и число — ни ников, ни id игроков. Только добавление.
CREATE TABLE "name_rule_hit_day" (
    "rule_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "hits" INTEGER NOT NULL,

    CONSTRAINT "name_rule_hit_day_pkey" PRIMARY KEY ("rule_id","day")
);

-- CreateIndex
CREATE INDEX "name_rule_hit_day_day_idx" ON "name_rule_hit_day"("day");

-- AddForeignKey
ALTER TABLE "name_rule_hit_day" ADD CONSTRAINT "name_rule_hit_day_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "name_rule"("rule_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "name_rule_hit_day" ADD CONSTRAINT "name_rule_hit_day_hits_check" CHECK ("hits" >= 0);
