-- Задания рекламных сетей во вкладке «Партнёры» (docs/35-stage4-plan.md
-- WP13, часть 6, Р80): строка на сеть — сколько её заданий игрок получит за
-- игровые сутки, пауза после выполненного и награда. Сами задания приходят
-- от сети, каталогу заданий их не завести.

-- CreateTable
CREATE TABLE "network_task" (
    "network_key" VARCHAR(32) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "daily_cap" SMALLINT NOT NULL,
    "pause_min" INTEGER NOT NULL,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "gems" INTEGER NOT NULL DEFAULT 0,
    "shards" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "network_task_pkey" PRIMARY KEY ("network_key")
);

-- AddForeignKey
ALTER TABLE "network_task" ADD CONSTRAINT "network_task_network_key_fkey" FOREIGN KEY ("network_key") REFERENCES "ad_network"("network_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Те же пределы, что у формы панели (`tasks/network-task-rules.ts`). Пауза
-- не короче пяти минут: она же не даёт повтору подтверждения сети выполнить
-- следующее задание игрока.
ALTER TABLE "network_task" ADD CONSTRAINT "network_task_cap_check" CHECK ("daily_cap" BETWEEN 1 AND 50);
ALTER TABLE "network_task" ADD CONSTRAINT "network_task_pause_check" CHECK ("pause_min" BETWEEN 5 AND 1440);
ALTER TABLE "network_task" ADD CONSTRAINT "network_task_reward_check" CHECK ("coins" >= 0 AND "gems" >= 0 AND "shards" >= 0 AND "coins" + "gems" + "shards" > 0);

-- Рабочие числа (О41, Р31): пять заданий AdsGram в сутки, не чаще раза в
-- полчаса, по сотне монет — как ежедневное задание. Строка включена: игрок
-- увидит задания, как только в «Рекламе» заведут Task-блок, а в «Ключах
-- интеграций» — адрес награды; без них строки сети у игрока нет.
INSERT INTO "network_task" ("network_key", "active", "daily_cap", "pause_min", "coins", "updated_at")
VALUES ('adsgram', true, 5, 30, 100, CURRENT_TIMESTAMP)
ON CONFLICT ("network_key") DO NOTHING;
