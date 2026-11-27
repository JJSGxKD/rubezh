-- Формат рассылки и отметка теста себе (docs/35-stage4-plan.md Р199, tasks/T-0403):
-- `plain` — простой текст, `rich` — ограниченный Markdown. Старые строки получают
-- умолчание — простой текст — и остаются без отметки теста.

-- AlterTable
ALTER TABLE "broadcast" ADD COLUMN     "format" VARCHAR(8) NOT NULL DEFAULT 'plain',
ADD COLUMN     "tested_hash" VARCHAR(64);
