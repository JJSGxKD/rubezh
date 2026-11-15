-- Публикация контента (tasks/T-0306, docs/19-content-admin.md §4.4–§4.5): указатель «какая
-- версия сейчас в игре» для команды и для всех и отметка версии «бывала у всех». Только новая
-- таблица и новая пустая колонка: код прошлого релиза на такой схеме работает, а пока строк нет,
-- клиент играет встроенным контентом.

-- AlterTable
ALTER TABLE "content_version" ADD COLUMN     "released_all_at" TIMESTAMPTZ(3);

-- Версия, что бывала у всех, обязана быть и опубликованной: отметка без `published_at` — ошибка записи.
ALTER TABLE "content_version" ADD CONSTRAINT "content_version_released_all_check" CHECK ("released_all_at" IS NULL OR "published_at" IS NOT NULL);

-- CreateTable
CREATE TABLE "content_current" (
    "audience" VARCHAR(4) NOT NULL,
    "version_no" INTEGER NOT NULL,
    "set_by" UUID,
    "set_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_current_pkey" PRIMARY KEY ("audience")
);

-- CreateIndex
CREATE INDEX "content_current_version_no_idx" ON "content_current"("version_no");

-- AddForeignKey
ALTER TABLE "content_current" ADD CONSTRAINT "content_current_version_no_fkey" FOREIGN KEY ("version_no") REFERENCES "content_version"("version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Аудитория — из списка: опечатка в коде не должна стать третьей строкой, которую клиент не умеет читать.
ALTER TABLE "content_current" ADD CONSTRAINT "content_current_audience_check" CHECK ("audience" IN ('team', 'all'));
