import { z } from "zod";

/**
 * Тела запросов авторизации. Данные с границы разбираются схемой, а не
 * приводятся через `as` (CLAUDE.md, «Стиль кода»).
 *
 * Верхние границы длины стоят не для красоты: без них разбор строки запуска и
 * поиск токена в хранилище принимают мегабайты на каждый запрос.
 */

/** Строка запуска Telegram: пары ключ-значение с подписью; длиннее 4 КБ не бывает. */
export const telegramLoginSchema = z.object({
  initData: z.string().min(1).max(4096),
});

/** Токен продления — 32 случайных байта в base64url, то есть ровно 43 знака. */
export const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(128),
});

/** Вход разработчика: `dev-<id>:Имя` (dev-login.ts). */
export const devLoginSchema = z.object({
  devUser: z.string().min(1).max(128),
});

export type TelegramLogin = z.infer<typeof telegramLoginSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;
