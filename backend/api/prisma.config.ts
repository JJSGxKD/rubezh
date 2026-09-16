import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Настройка CLI Prisma 7: схема, миграции и строка подключения.
 *
 * `.env` один на монорепо и лежит в корне (docs/20-env-and-ports.md §1).
 * Prisma 7 окружение сама не читает, поэтому корневой файл подгружается
 * здесь; в контейнере переменные уже заданы, и файла там нет.
 *
 * Строка подключения берётся без `env()` из `prisma/config`: тот падает на
 * пустой переменной, а генерации клиента база не нужна — `pnpm install` на
 * свежем клоне и шаг CI до поднятия базы не должны требовать секрета.
 * Миграции без строки подключения падают сами, с понятной ошибкой Prisma.
 */
loadDotenv({ path: resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
