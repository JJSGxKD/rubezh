-- AlterTable
ALTER TABLE "wheel_spin" ADD COLUMN "ad_session_id" VARCHAR(32);

-- CreateIndex
CREATE UNIQUE INDEX "wheel_spin_ad_session_id_key" ON "wheel_spin"("ad_session_id");

-- Сессия показа — ровно у крутки за рекламу: бесплатная без неё, рекламная
-- без неё не бывает. NOT VALID: прежние строки не проверяются — сервер до
-- WP12 рекламных круток не принимал, а в тестовых базах команды остались
-- рекламные строки без сессии от интеграционных тестов, и миграция упала бы
-- на них. Новые и изменённые строки проверка держит.
ALTER TABLE "wheel_spin" ADD CONSTRAINT "wheel_spin_ad_session_check" CHECK (("source" = 'ad') = ("ad_session_id" IS NOT NULL)) NOT VALID;
