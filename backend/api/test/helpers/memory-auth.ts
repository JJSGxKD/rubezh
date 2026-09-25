import type { Account, AccountIdentity, AccountRepository } from "../../src/modules/auth/account.repository.js";
import type { RefreshSession, RefreshStore, RefreshTake } from "../../src/modules/auth/refresh.store.js";

/**
 * Аккаунты и токены продления в памяти — для тестов сервиса. Смысл тот же,
 * что у настоящих реализаций: аккаунт узнаётся по паре «площадка + id»,
 * погашенный токен оставляет след, по которому ловится повторное
 * использование. Сами реализации проверяются отдельно — на живом Redis и на
 * живом Postgres.
 */

export class MemoryAccountRepository implements AccountRepository {
  private readonly byKey = new Map<string, Account>();

  async upsert(identity: AccountIdentity, nowMs: number): Promise<Account> {
    const key = `${identity.platform}:${identity.platformUserId}`;
    const existing = this.byKey.get(key);

    if (existing !== undefined) {
      const updated: Account = { ...existing, ...identity, created: false };
      this.byKey.set(key, updated);
      return updated;
    }

    const account: Account = {
      accountId: crypto.randomUUID(),
      ...identity,
      createdAt: new Date(nowMs),
      bannedAt: null,
      banReason: null,
      created: true,
    };
    this.byKey.set(key, account);
    return account;
  }

  async byPlatformUser(platform: string, platformUserId: string): Promise<Account | null> {
    const account = this.byKey.get(`${platform}:${platformUserId}`);
    return account === undefined ? null : { ...account, created: false };
  }

  async byId(accountId: string): Promise<Account | null> {
    for (const account of this.byKey.values()) {
      if (account.accountId === accountId) return { ...account, created: false };
    }
    return null;
  }

  /** Заблокировать аккаунт — так же, как это сделает администратор в WP2. */
  ban(accountId: string, reason: string): void {
    for (const [key, account] of this.byKey.entries()) {
      if (account.accountId === accountId) this.byKey.set(key, { ...account, bannedAt: new Date(), banReason: reason });
    }
  }
}

export class MemoryRefreshStore implements RefreshStore {
  /** выпуск падает — так проверяется компенсирующий откат */
  failIssue = false;
  private readonly live = new Map<string, RefreshSession>();
  private readonly used = new Map<string, string>();

  async issue(accountId: string, tokenHash: string, issuedAtMs: number): Promise<void> {
    if (this.failIssue) throw new Error("хранилище недоступно");
    this.live.set(tokenHash, { accountId, issuedAtMs });
  }

  async take(tokenHash: string): Promise<RefreshTake> {
    const session = this.live.get(tokenHash);
    if (session !== undefined) {
      this.live.delete(tokenHash);
      this.used.set(tokenHash, session.accountId);
      return { status: "ok", session };
    }

    const accountId = this.used.get(tokenHash);
    return accountId === undefined ? { status: "unknown" } : { status: "reused", accountId };
  }

  async restore(session: RefreshSession, tokenHash: string): Promise<void> {
    this.live.set(tokenHash, session);
    this.used.delete(tokenHash);
  }

  async revokeAll(accountId: string): Promise<number> {
    let removed = 0;
    for (const [hash, session] of this.live.entries()) {
      if (session.accountId === accountId) {
        this.live.delete(hash);
        removed++;
      }
    }
    return removed;
  }

  get liveCount(): number {
    return this.live.size;
  }
}
