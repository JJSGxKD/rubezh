/**
 * Включённая авторизация в конфигурации тестов. Плейтест и забеги без неё не
 * включаются (docs/34-stage3-plan.md, WP4). Вход включается ключом — секретом
 * подписи (Р53), и ему нужны токен бота и адрес базы — сама база тестам без
 * Prisma не нужна.
 */
export const AUTH_ENV = {
  JWT_ACCESS_SECRET: "a1".repeat(32),
  TELEGRAM_BOT_TOKEN: "123456:TEST",
  DATABASE_URL: "postgresql://unused",
} as const;
