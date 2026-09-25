import { newFriendCode } from "../../src/modules/friends/friend-code.js";
import {
  orderedPair,
  type BefriendOutcome,
  type FriendPeer,
  type FriendRow,
  type FriendSource,
  type FriendsRepository,
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
