/**
 * Хранилище токенов продления (docs/34-stage3-plan.md, WP1).
 *
 * **Почему токен непрозрачный, а не JWT.** Токен продления всё равно
 * проверяется по хранилищу — иначе его не отозвать, — и подпись не даёт
 * ничего сверх этого, зато добавляет второй секрет и разбор формата. Поэтому
 * здесь случайные 32 байта, а в Redis лежит только их SHA-256: слепок базы не
 * даёт рабочих токенов. Ротация, отзыв и несколько устройств от этого не
 * страдают — они и так делаются хранилищем.
 *
 * Интерфейс отдельно от Redis: сервис проверяется без Redis, а реализация —
 * отдельным тестом на живом Redis (docs/17-testing-strategy.md §4.2).
 */

export const REFRESH_STORE = Symbol("REFRESH_STORE");

export interface RefreshSession {
  accountId: string;
  issuedAtMs: number;
}

/**
 * Что вернуло гашение токена.
 *
 * `reused` — токен уже гасили раньше. Либо его украли и им воспользовался
 * второй, либо клиент повторил запрос; отличить нельзя, поэтому сессии
 * аккаунта сбрасываются целиком — это дешевле угнанного аккаунта.
 */
export type RefreshTake =
  | { status: "ok"; session: RefreshSession }
  | { status: "reused"; accountId: string }
  | { status: "unknown" };

export interface RefreshStore {
  /** Запомнить выпущенный токен. Сверх потолка устройств вытесняется самое старое. */
  issue(accountId: string, tokenHash: string, issuedAtMs: number): Promise<void>;
  /** Забрать и погасить — атомарно: два параллельных обновления не должны пройти оба. */
  take(tokenHash: string): Promise<RefreshTake>;
  /**
   * Вернуть погашенный токен обратно.
   *
   * Компенсирующий откат: если выпуск новой пары упал уже после гашения
   * старой, игрок остался бы без входа вовсе — с живой сессией, которой
   * нечем воспользоваться (docs/13-reuse-from-vpnsibcom.md §4).
   */
  restore(session: RefreshSession, tokenHash: string): Promise<void>;
  /** Отозвать все сессии аккаунта; возвращает, сколько их было. */
  revokeAll(accountId: string): Promise<number>;
}
