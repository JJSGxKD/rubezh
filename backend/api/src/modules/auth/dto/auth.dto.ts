import { z } from "zod";

/**
 * Тела запросов авторизации. Данные с границы разбираются схемой, а не
 * приводятся через `as` (CLAUDE.md, «Стиль кода»).
 *
 * Верхние границы длины стоят не для красоты: без них разбор строки запуска и
 * поиск токена в хранилище принимают мегабайты на каждый запрос.
 */

/**
 * Что клиент говорит о себе — платформа и версия клиента Telegram. Подсказка
 * для разрезов, не для решений: подписи у неё нет. Мусор в ней не роняет
 * вход, а просто не запоминается (`attribution/client-class.ts`).
 */
const clientSchema = z.object({
  platform: z.string().max(32).nullable(),
  version: z.string().max(32).nullable(),
});

/**
 * Зачем вход: на запуске игры или повторно посреди работы, когда сессия
 * потерялась. Сессией считается только запуск; без поля — запуск, как у
 * сборок до этого поля.
 */
const reasonSchema = z.enum(["launch", "reauth"]).default("launch");

/** Строка запуска Telegram: пары ключ-значение с подписью; длиннее 4 КБ не бывает. */
export const telegramLoginSchema = z.object({
  initData: z.string().min(1).max(4096),
  client: clientSchema.optional(),
  reason: reasonSchema,
});

/** Токен продления — 32 случайных байта в base64url, то есть ровно 43 знака. */
export const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(128),
});

/** Вход разработчика: `dev-<id>:Имя` (dev-login.ts). */
export const devLoginSchema = z.object({
  devUser: z.string().min(1).max(128),
  reason: reasonSchema,
});

export type TelegramLogin = z.infer<typeof telegramLoginSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;
