import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig, env } from "prisma/config";

/**
 * Настройка CLI Prisma 7: схема, миграции и строка подключения.
 *
 * `.env` один на монорепо и лежит в корне (docs/20-env-and-ports.md §1).
 * Prisma 7 окружение сама не читает, поэтому корневой файл подгружается
 * здесь; в контейнере переменные уже заданы, и файла там нет.
 */
loadDotenv({ path: resolve(import.meta.dirname, "../../.env")});

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
