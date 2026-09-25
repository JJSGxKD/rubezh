import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { PRISMA } from "../../infra/database.js";
import { newFriendCode } from "./friend-code.js";

/**
 * Хранилище дружбы (docs/35-stage4-plan.md §3.8). Инварианты — потолок
 * друзей и заявок — проверяются в транзакции под блокировкой строк обоих
 * аккаунтов: две одновременные дружбы у одного игрока иначе прошли бы
 * потолок вдвоём.
 */

export type FriendSource = "link" | "request";

/** Другой игрок в списке: то же, что и так видно в рейтинге, — имя и аватар. */
export interface FriendPeer {
  accountId: string;
  displayName: string;
  photoUrl: string | null;
}

export interface FriendRow extends FriendPeer {
  since: Date;
  source: FriendSource;
}

export interface RequestRow extends FriendPeer {
  at: Date;
}

export type BefriendOutcome = { outcome: "added" } | { outcome: "already" } | { outcome: "limit"; accountId: string };
export type RequestOutcome = "sent" | "exists" | "incoming_full" | "outgoing_full";

/** Незабранный подарок: от кого и за какие игровые сутки (`YYYY-MM-DD`). */
export interface PendingGift {
  fromAccountId: string;
  day: string;
}

export interface RequestLimits {
  maxIncoming: number;
  maxOutgoing: number;
}

export const FRIENDS_REPOSITORY = Symbol("FRIENDS_REPOSITORY");

export interface FriendsRepository {
  /** Код ссылки дружбы аккаунта; нет — заводится. Одна и постоянная. */
  linkOf(accountId: string): Promise<string>;
  /** Чья ссылка; `null` — такого кода нет. */
  ownerOf(code: string): Promise<string | null>;
  friends(accountId: string, limit: number): Promise<FriendRow[]>;
  incoming(accountId: string, limit: number): Promise<RequestRow[]>;
  outgoing(accountId: string, limit: number): Promise<RequestRow[]>;
  areFriends(a: string, b: string): Promise<boolean>;
  hasRequest(from: string, to: string): Promise<boolean>;
  /** Подружить; заявки между ними, если были, исполнены — удаляются. */
  befriend(a: string, b: string, source: FriendSource, maxFriends: number): Promise<BefriendOutcome>;
  request(from: string, to: string, limits: RequestLimits): Promise<RequestOutcome>;
  dropRequest(from: string, to: string): Promise<boolean>;
  remove(a: string, b: string): Promise<boolean>;
  /** Подарок за текущие игровые сутки; `false` — сегодня этому другу уже дарили. */
  sendGift(from: string, to: string): Promise<boolean>;
  /** Кому аккаунт уже подарил сегодня. */
  giftedToday(from: string): Promise<string[]>;
  /** Незабранные подарки не старше `maxAgeDays`, старые первыми. */
  pendingGifts(to: string, maxAgeDays: number, limit: number): Promise<PendingGift[]>;
  pendingGiftCount(to: string, maxAgeDays: number): Promise<number>;
  /** Сколько подарков забрано за текущие игровые сутки. */
  claimedToday(to: string): Promise<number>;
  markClaimed(from: string, to: string, day: string): Promise<void>;
}

/** Пара хранится меньшим идентификатором первым — так же проверяет база. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

const PEER = { accountId: true, displayName: true, photoUrl: true } as const;

@Injectable()
export class PrismaFriendsRepository implements FriendsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async linkOf(accountId: string): Promise<string> {
    const existing = await this.prisma.friendLink.findUnique({ where: { accountId } });
    if (existing !== null) return existing.code;
    try {
      const created = await this.prisma.friendLink.create({ data: { accountId, code: newFriendCode() } });
      return created.code;
    } catch (error: unknown) {
      // Две вкладки попросили ссылку разом — вторая берёт то, что завела первая.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.friendLink.findUnique({ where: { accountId } });
      if (raced === null) throw error;
      return raced.code;
    }
  }

  async ownerOf(code: string): Promise<string | null> {
    const link = await this.prisma.friendLink.findUnique({ where: { code }, select: { accountId: true } });
    return link?.accountId ?? null;
  }

  async friends(accountId: string, limit: number): Promise<FriendRow[]> {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ accountA: accountId }, { accountB: accountId }] },
      include: { a: { select: PEER }, b: { select: PEER } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({ ...(row.accountA === accountId ? row.b : row.a), since: row.createdAt, source: row.source }));
  }

  async incoming(accountId: string, limit: number): Promise<RequestRow[]> {
    const rows = await this.prisma.friendRequest.findMany({
      where: { toAccountId: accountId },
      include: { from: { select: PEER } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({ ...row.from, at: row.createdAt }));
  }

  async outgoing(accountId: string, limit: number): Promise<RequestRow[]> {
    const rows = await this.prisma.friendRequest.findMany({
      where: { fromAccountId: accountId },
      include: { to: { select: PEER } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({ ...row.to, at: row.createdAt }));
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const [accountA, accountB] = orderedPair(a, b);
    return (await this.prisma.friendship.count({ where: { accountA, accountB } })) > 0;
  }

  async hasRequest(from: string, to: string): Promise<boolean> {
    return (await this.prisma.friendRequest.count({ where: { fromAccountId: from, toAccountId: to } })) > 0;
  }

  async befriend(a: string, b: string, source: FriendSource, maxFriends: number): Promise<BefriendOutcome> {
    const [accountA, accountB] = orderedPair(a, b);
    return await this.prisma.$transaction(async (tx) => {
      await lockAccounts(tx, accountA, accountB);
      const betweenThem = { OR: [{ fromAccountId: a, toAccountId: b }, { fromAccountId: b, toAccountId: a }] };
      if ((await tx.friendship.count({ where: { accountA, accountB } })) > 0) {
        await tx.friendRequest.deleteMany({ where: betweenThem });
        return { outcome: "already" };
      }
      for (const accountId of [a, b]) {
        const count = await tx.friendship.count({ where: { OR: [{ accountA: accountId }, { accountB: accountId }] } });
        if (count >= maxFriends) return { outcome: "limit", accountId };
      }
      await tx.friendship.create({ data: { accountA, accountB, source } });
      await tx.friendRequest.deleteMany({ where: betweenThem });
      return { outcome: "added" };
    });
  }

  async request(from: string, to: string, limits: RequestLimits): Promise<RequestOutcome> {
    const [first, second] = orderedPair(from, to);
    return await this.prisma.$transaction(async (tx) => {
      await lockAccounts(tx, first, second);
      if ((await tx.friendRequest.count({ where: { fromAccountId: from, toAccountId: to } })) > 0) return "exists";
      if ((await tx.friendRequest.count({ where: { toAccountId: to } })) >= limits.maxIncoming) return "incoming_full";
      if ((await tx.friendRequest.count({ where: { fromAccountId: from } })) >= limits.maxOutgoing) return "outgoing_full";
      await tx.friendRequest.create({ data: { fromAccountId: from, toAccountId: to } });
      return "sent";
    });
  }

  async dropRequest(from: string, to: string): Promise<boolean> {
    const { count } = await this.prisma.friendRequest.deleteMany({ where: { fromAccountId: from, toAccountId: to } });
    return count > 0;
  }

  async remove(a: string, b: string): Promise<boolean> {
    const [accountA, accountB] = orderedPair(a, b);
    const { count } = await this.prisma.friendship.deleteMany({ where: { accountA, accountB } });
    return count > 0;
  }

  async sendGift(from: string, to: string): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO friend_gift (from_account_id, to_account_id, day)
      VALUES (${from}::uuid, ${to}::uuid, ${TODAY})
      ON CONFLICT DO NOTHING`;
    return inserted > 0;
  }

  async giftedToday(from: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ to_account_id: string }[]>`
      SELECT to_account_id FROM friend_gift WHERE from_account_id = ${from}::uuid AND day = ${TODAY}`;
    return rows.map((row) => row.to_account_id);
  }

  async pendingGifts(to: string, maxAgeDays: number, limit: number): Promise<PendingGift[]> {
    const rows = await this.prisma.$queryRaw<{ from_account_id: string; day: string }[]>`
      SELECT from_account_id, to_char(day, 'YYYY-MM-DD') AS day FROM friend_gift
      WHERE to_account_id = ${to}::uuid AND claimed_at IS NULL AND day > ${TODAY} - ${maxAgeDays}::int
      ORDER BY day, created_at LIMIT ${limit}`;
    return rows.map((row) => ({ fromAccountId: row.from_account_id, day: row.day }));
  }

  async pendingGiftCount(to: string, maxAgeDays: number): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM friend_gift
      WHERE to_account_id = ${to}::uuid AND claimed_at IS NULL AND day > ${TODAY} - ${maxAgeDays}::int`;
    return row?.count ?? 0;
  }

  async claimedToday(to: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM friend_gift
      WHERE to_account_id = ${to}::uuid AND claimed_at IS NOT NULL
        AND (claimed_at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date = ${TODAY}`;
    return row?.count ?? 0;
  }

  async markClaimed(from: string, to: string, day: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE friend_gift SET claimed_at = now()
      WHERE from_account_id = ${from}::uuid AND to_account_id = ${to}::uuid AND day = ${day}::date AND claimed_at IS NULL`;
  }
}

/** Игровые сутки считает база — так граница одна у всех реплик (`common/game-day.ts`). */
const TODAY = Prisma.sql`(now() AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`;

/** Строки аккаунтов — по порядку идентификаторов: встречные транзакции не встанут в клинч. */
async function lockAccounts(tx: Prisma.TransactionClient, first: string, second: string): Promise<void> {
  await tx.$queryRaw`SELECT account_id FROM account WHERE account_id IN (${first}::uuid, ${second}::uuid) ORDER BY account_id FOR UPDATE`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
