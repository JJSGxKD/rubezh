-- Список игроков в панели (WP32): сортировка и страница — по индексу.
-- Без CONCURRENTLY: аккаунтов на тесте сотни, индекс строится мгновенно, а
-- миграция Prisma идёт в транзакции, где CONCURRENTLY запрещён.

-- CreateIndex
CREATE INDEX "account_created_at_account_id_idx" ON "account"("created_at", "account_id");

-- CreateIndex
CREATE INDEX "account_last_seen_at_account_id_idx" ON "account"("last_seen_at", "account_id");

-- CreateIndex
CREATE INDEX "account_progress_level_account_id_idx" ON "account_progress"("level", "account_id");
