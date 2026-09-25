-- Выгрузка кнопкой из панели (docs/35-stage4-plan.md, WP17): третий источник
-- в журнале выгрузок рядом с ботом и командной строкой.
-- AlterEnum
ALTER TYPE "ExportSource" ADD VALUE 'panel';
