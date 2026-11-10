-- Снимки аудитории по суткам (tasks/T-0203): DAU, WAU и MAU закрытых московских суток.
-- Вайп таблицу не стирает: история строится из сессий запуска.
-- CreateTable
CREATE TABLE "activity_daily" (
    "day" VARCHAR(10) NOT NULL,
    "dau" INTEGER NOT NULL,
    "wau" INTEGER NOT NULL,
    "mau" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_daily_pkey" PRIMARY KEY ("day")
);

