import type { AccessTokenClaims } from "../auth/access-token.js";

/**
 * Что `AuthGuard` знает о счётчике онлайна: только «отметь активность».
 * Узкий порт, а не весь сервис, — иначе авторизация зависела бы от модуля,
 * который сам зависит от авторизации (цикл), а десятки тестов гарда
 * тянули бы за собой настройки и Redis.
 */
export interface OnlineActivity {
  /** Не ждёт хранилища и не бросает: активность — счётчик, а не условие ответа игроку. */
  touch(claims: AccessTokenClaims, now: Date): void;
}

export const ONLINE_ACTIVITY = Symbol("ONLINE_ACTIVITY");
