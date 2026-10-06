-- Задания обмена трафиком Taddy во вкладке «Партнёры» (docs/35-stage4-plan.md
-- WP13, часть 6, Р80). Задание ленты — креатив сессии места `task`
-- (`creative_id`): по нему сервер спрашивает Taddy, выполнено ли оно.

-- Одно задание ленты — одна награда игроку. Лента без выполненных их не
-- отдаёт, а сервер не выбирает уже выполненное, но Taddy может вернуть
-- задание снова — тогда второе выполнение не запишется. Задания SDK сети
-- (AdsGram) креатива не несут и под индекс не попадают.
CREATE UNIQUE INDEX "ad_session_task_creative_key" ON "ad_session"("account_id", "network_key", "creative_id")
WHERE "place" = 'task' AND "completed_at" IS NOT NULL AND "creative_id" IS NOT NULL;

-- Рабочие числа (О41, Р31) — те же, что у AdsGram: пять заданий в сутки, не
-- чаще раза в полчаса, по сотне монет. Игрок тратит на задание то же — запуск
-- бота, — и одна цена за одно усилие понятнее двух. Строка включена: игрок
-- увидит задания, когда в «Рекламе» включат Taddy с блоком «Обмен трафиком»
-- в месте «Задания».
INSERT INTO "network_task" ("network_key", "active", "daily_cap", "pause_min", "coins", "updated_at")
VALUES ('taddy', true, 5, 30, 100, CURRENT_TIMESTAMP)
ON CONFLICT ("network_key") DO NOTHING;
