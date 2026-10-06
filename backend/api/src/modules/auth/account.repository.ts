import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { AccountPlatform } from "./access-token.js";

/**
 * Аккаунты игроков (docs/34-stage3-plan.md, WP1). Запрос к базе живёт здесь,
 * а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

export interface AccountIdentity {
  platform: AccountPlatform;
  platformUserId: string;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
}

/**
 * Что площадка сообщила об игроке при входе. Аватар бывает неизвестен: в
 * обновлении бота его нет, а в подписи запуска Mini App есть. Неизвестный
 * (`undefined`) не затирает сохранённый — иначе `/start` стирал бы аватар,
 * полученный при входе в приложение.
 */
export type AccountArrival = Omit<AccountIdentity, "photoUrl"> & { photoUrl?: string | null };

export interface Account extends AccountIdentity {
  accountId: string;
  createdAt: Date;
  /** `null` — аккаунт не заблокирован */
  bannedAt: Date | null;
  banReason: string | null;
  /** аккаунт заведён этим входом, а не найден */
  created: boolean;
}

export const ACCOUNT_REPOSITORY = Symbol("ACCOUNT_REPOSITORY");

export interface AccountRepository {
  /**
   * Найти аккаунт по площадке или завести. Имя и аватар обновляются на каждом
   * входе: игрок сменил их в Telegram — мы показываем новые, а не те, что
   * запомнили при регистрации.
   */
  upsert(identity: AccountArrival, nowMs: number): Promise<Account>;
  byId(accountId: string): Promise<Account | null>;
  /** Имена аккаунтов одним запросом — для списков панели; ненайденных в ответе нет. */
  displayNames(accountIds: readonly string[]): Promise<Map<string, string>>;
  /** Найти по площадке и её идентификатору — так аккаунт ищут по Telegram ID */
  byPlatformUser(platform: AccountPlatform, platformUserId: string): Promise<Account | null>;
  /**
   * Поиск для панели: идентификатор на площадке — точно, юзернейм — по
   * началу, имя — по вхождению; недавние первыми. Пустой запрос — пусто, а не
   * вся таблица.
   */
  search(query: string, limit: number): Promise<Account[]>;
  /** Заблокировать или снять блокировку; `null` — аккаунта нет. */
  setBan(accountId: string, ban: AccountBan | null): Promise<Account | null>;
  /**
   * Страница получателей раздачи всем (выход версии, WP31): незаблокированные
   * аккаунты площадок, заходившие не раньше `seenSince`, по возрастанию id
   * после `after`. Курсор — id, а не номер страницы: аккаунты, заведённые
   * посреди раздачи, не сдвигают страницы.
   */
  recipientsPage(page: RecipientsPage): Promise<string[]>;
}

export interface RecipientsPage {
  platforms: readonly AccountPlatform[];
  seenSince: Date;
  /** `null` — с начала */
  after: string | null;
  limit: number;
}

export interface AccountBan {
  at: Date;
  reason: string;
}

@Injectable()
export class PrismaAccountRepository implements AccountRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async upsert(identity: AccountArrival, nowMs: number): Promise<Account> {
    const now = new Date(nowMs);
    const key = { platform: identity.platform, platformUserId: identity.platformUserId };

    // Признак «завели сейчас» — по времени создания: upsert не говорит, какая
    // из веток сработала, а событие user_registered нужно ровно один раз.
    const row = await this.prisma.account.upsert({
      where: { platform_platformUserId: key },
      create: { accountId: crypto.randomUUID(), ...identity, createdAt: now, lastSeenAt: now },
      update: {
        displayName: identity.displayName,
        username: identity.username,
        ...(identity.photoUrl === undefined ? {} : { photoUrl: identity.photoUrl }),
        lastSeenAt: now,
      },
    });

    return toAccount(row, row.createdAt.getTime() === now.getTime());
  }

  async byId(accountId: string): Promise<Account | null> {
    const row = await this.prisma.account.findUnique({ where: { accountId } });
    return row === null ? null : toAccount(row, false);
  }

  async displayNames(accountIds: readonly string[]): Promise<Map<string, string>> {
    if (accountIds.length === 0) return new Map();
    const rows = await this.prisma.account.findMany({ where: { accountId: { in: [...accountIds] } }, select: { accountId: true, displayName: true } });
    return new Map(rows.map((row) => [row.accountId, row.displayName]));
  }

  async byPlatformUser(platform: AccountPlatform, platformUserId: string): Promise<Account | null> {
    const row = await this.prisma.account.findUnique({
      where: { platform_platformUserId: { platform, platformUserId } },
    });
    return row === null ? null : toAccount(row, false);
  }

  async search(query: string, limit: number): Promise<Account[]> {
    // `@` перед юзернеймом — привычка из Telegram, а не часть значения.
    const text = query.trim().replace(/^@/, "");
    if (text === "") return [];
    // Вхождение в имя — просмотр таблицы: на закрытом тесте игроков сотни, и
    // индекс по имени понадобится вместе с ростом (docs/14-scalability.md).
    const rows = await this.prisma.account.findMany({
      where: {
        OR: [
          { platformUserId: text },
          { username: { startsWith: text, mode: "insensitive" } },
          { displayName: { contains: text, mode: "insensitive" } },
        ],
      },
      orderBy: { lastSeenAt: "desc" },
      take: limit,
    });
    return rows.map((row) => toAccount(row, false));
  }

  async setBan(accountId: string, ban: AccountBan | null): Promise<Account | null> {
    // updateMany, а не update: несуществующий аккаунт — `null`, а не исключение Prisma.
    const updated = await this.prisma.account.updateMany({
      where: { accountId },
      data: { bannedAt: ban?.at ?? null, banReason: ban?.reason ?? null },
    });
    return updated.count === 0 ? null : await this.byId(accountId);
  }

  async recipientsPage(page: RecipientsPage): Promise<string[]> {
    if (page.platforms.length === 0 || page.limit <= 0) return [];
    // По первичному ключу: страница — отрезок индекса, а не сортировка всей выборки.
    const rows = await this.prisma.account.findMany({
      where: {
        platform: { in: [...page.platforms] },
        bannedAt: null,
        lastSeenAt: { gte: page.seenSince },
        ...(page.after === null ? {} : { accountId: { gt: page.after } }),
      },
      orderBy: { accountId: "asc" },
      take: page.limit,
      select: { accountId: true },
    });
    return rows.map((row) => row.accountId);
  }
}

type AccountRow = {
  accountId: string;
  platform: string;
  platformUserId: string;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  createdAt: Date;
  bannedAt: Date | null;
  banReason: string | null;
};

function toAccount(row: AccountRow, created: boolean): Account {
  return {
    accountId: row.accountId,
    platform: row.platform as AccountPlatform,
    platformUserId: row.platformUserId,
    displayName: row.displayName,
    username: row.username,
    photoUrl: row.photoUrl,
    createdAt: row.createdAt,
    bannedAt: row.bannedAt,
    banReason: row.banReason,
    created,
  };
}
