import type { AdminSession, AdminSessionStore } from "../../src/modules/admin/admin-session.store.js";

/**
 * Сессии панели в памяти — для тестов сервиса и гварда. Смысл тот же, что у
 * Redis: сессия ищется по хэшу токена, отзыв по аккаунту снимает все его
 * сессии. Сама реализация проверяется на живом Redis в интеграционном тесте.
 */
export class MemoryAdminSessionStore implements AdminSessionStore {
  readonly sessions = new Map<string, AdminSession>();

  async put(tokenHash: string, session: AdminSession): Promise<void> {
    this.sessions.set(tokenHash, { ...session });
  }

  async get(tokenHash: string): Promise<AdminSession | null> {
    const session = this.sessions.get(tokenHash);
    return session === undefined ? null : { ...session };
  }

  async delete(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async revokeAll(accountId: string): Promise<number> {
    let removed = 0;
    for (const [hash, session] of this.sessions) {
      if (session.accountId === accountId) {
        this.sessions.delete(hash);
        removed++;
      }
    }
    return removed;
  }
}
