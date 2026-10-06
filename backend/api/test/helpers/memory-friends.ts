import { newFriendCode } from "../../src/modules/friends/friend-code.js";
import {
  orderedPair,
  type BefriendOutcome,
  type FriendPeer,
  type FriendRow,
  type FriendSource,
  type FriendsRepository,
  type PendingGift,
  type RequestLimits,
  type RequestOutcome,
  type RequestRow,
} from "../../src/modules/friends/friends.repository.js";
import type { MemoryAccountRepository } from "./memory-auth.js";

/** Дружба в памяти — для тестов сервиса и HTTP; Prisma-реализацию проверяет интеграционный тест. */
export class MemoryFriendsRepository implements FriendsRepository {
  readonly links = new Map<string, string>();
  readonly pairs = new Map<string, { since: Date; source: FriendSource }>();
  readonly requests = new Map<string, Date>();
  /** ключ `от|кому|сутки` → когда забран; `null` — ждёт */
  readonly gifts = new Map<string, Date | null>();
  /** кто сыграл честный забег — тест отмечает сам, забегов в памяти нет */
  readonly played = new Set<string>();
  /** ключ `аккаунт|порог` → монеты забранной ступени */
  readonly bonuses = new Map<string, number>();
  /** «сегодня» в игровых сутках; тест двигает его, чтобы проверить смену суток */
  today = moscowDay(new Date());

  constructor(private readonly accounts: MemoryAccountRepository) {}

  async linkOf(accountId: string): Promise<string> {
    for (const [code, owner] of this.links) if (owner === accountId) return code;
    const code = newFriendCode();
    this.links.set(code, accountId);
    return code;
  }

  async ownerOf(code: string): Promise<string | null> {
    return this.links.get(code) ?? null;
  }

  async friends(accountId: string, limit: number): Promise<FriendRow[]> {
    const rows: FriendRow[] = [];
    for (const [key, pair] of this.pairs) {
      const [a, b] = key.split("|") as [string, string];
      if (a !== accountId && b !== accountId) continue;
      rows.push({ ...(await this.peer(a === accountId ? b : a)), ...pair });
    }
    return rows.slice(0, limit);
  }

  async count(accountId: string): Promise<number> {
    return (await this.friends(accountId, Number.MAX_SAFE_INTEGER)).length;
  }

  async incoming(accountId: string, limit: number): Promise<RequestRow[]> {
    return (await this.requestRows((from, to) => (to === accountId ? from : null))).slice(0, limit);
  }

  async outgoing(accountId: string, limit: number): Promise<RequestRow[]> {
    return (await this.requestRows((from, to) => (from === accountId ? to : null))).slice(0, limit);
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    return this.pairs.has(orderedPair(a, b).join("|"));
  }

  async hasRequest(from: string, to: string): Promise<boolean> {
    return this.requests.has(`${from}|${to}`);
  }

  async befriend(a: string, b: string, source: FriendSource, maxFriends: number): Promise<BefriendOutcome> {
    const key = orderedPair(a, b).join("|");
    if (this.pairs.has(key)) {
      this.dropBoth(a, b);
      return { outcome: "already" };
    }
    for (const accountId of [a, b]) if ((await this.friends(accountId, Number.MAX_SAFE_INTEGER)).length >= maxFriends) return { outcome: "limit", accountId };
    this.pairs.set(key, { since: new Date(), source });
    this.dropBoth(a, b);
    return { outcome: "added" };
  }

  async request(from: string, to: string, limits: RequestLimits): Promise<RequestOutcome> {
    if (this.requests.has(`${from}|${to}`)) return "exists";
    if ([...this.requests.keys()].filter((key) => key.endsWith(`|${to}`)).length >= limits.maxIncoming) return "incoming_full";
    if ([...this.requests.keys()].filter((key) => key.startsWith(`${from}|`)).length >= limits.maxOutgoing) return "outgoing_full";
    this.requests.set(`${from}|${to}`, new Date());
    return "sent";
  }

  async dropRequest(from: string, to: string): Promise<boolean> {
    return this.requests.delete(`${from}|${to}`);
  }

  async remove(a: string, b: string): Promise<boolean> {
    return this.pairs.delete(orderedPair(a, b).join("|"));
  }

  async sendGift(from: string, to: string): Promise<boolean> {
    const key = `${from}|${to}|${this.today}`;
    if (this.gifts.has(key)) return false;
    this.gifts.set(key, null);
    return true;
  }

  async giftedToday(from: string): Promise<string[]> {
    return this.giftRows().filter((gift) => gift.from === from && gift.day === this.today).map((gift) => gift.to);
  }

  async pendingGifts(to: string, maxAgeDays: number, limit: number): Promise<PendingGift[]> {
    return this.giftRows()
      .filter((gift) => gift.to === to && gift.claimedAt === null && this.age(gift.day) < maxAgeDays)
      .sort((left, right) => left.day.localeCompare(right.day))
      .slice(0, limit)
      .map((gift) => ({ fromAccountId: gift.from, day: gift.day }));
  }

  async pendingGiftCount(to: string, maxAgeDays: number): Promise<number> {
    return (await this.pendingGifts(to, maxAgeDays, Number.MAX_SAFE_INTEGER)).length;
  }

  async claimedToday(to: string): Promise<number> {
    return this.giftRows().filter((gift) => gift.to === to && gift.claimedAt !== null && gift.claimedDay === this.today).length;
  }

  async markClaimed(from: string, to: string, day: string): Promise<void> {
    const key = `${from}|${to}|${day}`;
    if (this.gifts.get(key) === null) this.gifts.set(key, dayStart(this.today));
  }

  async qualifiedCount(accountId: string): Promise<number> {
    let count = 0;
    for (const friend of await this.friends(accountId, Number.MAX_SAFE_INTEGER)) {
      const account = await this.accounts.byId(friend.accountId);
      if (account !== null && account.bannedAt === null && this.played.has(friend.accountId)) count++;
    }
    return count;
  }

  async bonusClaimed(accountId: string): Promise<number[]> {
    return [...this.bonuses.keys()].filter((key) => key.startsWith(`${accountId}|`)).map((key) => Number(key.split("|")[1]));
  }

  async markBonusClaimed(accountId: string, friends: number, coins: number): Promise<void> {
    const key = `${accountId}|${friends}`;
    if (!this.bonuses.has(key)) this.bonuses.set(key, coins);
  }

  private giftRows(): { from: string; to: string; day: string; claimedAt: Date | null; claimedDay: string | null }[] {
    return [...this.gifts].map(([key, claimedAt]) => {
      const [from, to, day] = key.split("|") as [string, string, string];
      return { from, to, day, claimedAt, claimedDay: claimedAt === null ? null : moscowDay(claimedAt) };
    });
  }

  private age(day: string): number {
    return Math.round((Date.parse(`${this.today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  }

  private dropBoth(a: string, b: string): void {
    this.requests.delete(`${a}|${b}`);
    this.requests.delete(`${b}|${a}`);
  }

  private async requestRows(other: (from: string, to: string) => string | null): Promise<RequestRow[]> {
    const rows: RequestRow[] = [];
    for (const [key, at] of this.requests) {
      const [from, to] = key.split("|") as [string, string];
      const peerId = other(from, to);
      if (peerId !== null) rows.push({ ...(await this.peer(peerId)), at });
    }
    return rows;
  }

  private async peer(accountId: string): Promise<FriendPeer> {
    const account = await this.accounts.byId(accountId);
    return { accountId, displayName: account?.displayName ?? "?", photoUrl: account?.photoUrl ?? null };
  }
}

/** Игровые сутки по Москве — как их считает база (`common/game-day.ts`). */
export function moscowDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Полдень по Москве этих суток — момент, который точно попадает в них. */
function dayStart(day: string): Date {
  return new Date(`${day}T09:00:00Z`);
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
