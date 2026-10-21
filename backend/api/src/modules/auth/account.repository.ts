import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { AccountPlatform } from "./access-token.js";
import { displayNameFor, type CleanName } from "./display-name.js";

/**
 * Аккаунты игроков (docs/34-stage3-plan.md, WP1). Запрос к базе живёт здесь,
 * а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

/** Ширина столбцов `display_name` и `platform_name`: Postgres считает знаки, а не кодовые единицы. */
const DISPLAY_NAME_MAX = 128;
const PLATFORM_NAME_MAX = 256;

/**
 * Обрезка по знакам без многоточия. `slice` по строке разорвал бы пару
 * суррогатов (эмодзи) посередине, и в базу ушёл бы битый знак.
 */
function cutChars(text: string, max: number): string {
  return text.length <= max ? text : [...text].slice(0, max).join("");
}

/**
 * Ник, как он лежит в базе: очищенный и умещённый в столбец. Вход и команда
 * `names:clean` считают его одной функцией — иначе на длинной склейке эмодзи
 * они разошлись бы, и команда переписывала бы тот же ник при каждом запуске.
 */
export function storedNameFor(raw: string, username: string | null, accountId: string): CleanName {
  const clean = displayNameFor(raw, username, accountId);
  return { name: cutChars(clean.name, DISPLAY_NAME_MAX), verdict: clean.verdict };
}

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
  /**
   * Знак «Тестер» (Р87): когда аккаунт отмечен играющим до вайпа; `null` — не тестер. Необязателен в типе, чтобы
   * подмены, собирающие `Account` руками, не ломались; настоящее хранилище отдаёт его всегда.
   */
  testerAt?: Date | null;
  /**
   * Ник с площадки как пришёл при последнем входе — только для панели
   * (tasks/T-0150); `null` — аккаунт заведён до этого поля и не входил после.
   * Необязателен в типе по той же причине, что `testerAt`.
   */
  platformName?: string | null;
  /** Ник закреплён модератором, вход его не меняет; `null` — не закреплён. */
  nameLockedAt?: Date | null;
  /** аккаунт заведён этим входом, а не найден */
  created: boolean;
}

export const ACCOUNT_REPOSITORY = Symbol("ACCOUNT_REPOSITORY");

export interface AccountRepository {
  /**
   * Найти аккаунт по площадке или завести. Имя и аватар обновляются на каждом
   * входе: игрок сменил их в Telegram — мы показываем новые, а не те, что
   * запомнили при регистрации. Ник при этом чистится (`displayNameFor`), а
   * как пришёл — остаётся в `platformName` для панели; закреплённый
   * модератором ник вход не перезаписывает.
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

    const platformName = cutChars(identity.displayName, PLATFORM_NAME_MAX);
    const newAccountId = crypto.randomUUID();

    // Признак «завели сейчас» — по времени создания: upsert не говорит, какая
    // из веток сработала, а событие user_registered нужно ровно один раз.
    // Ветка update ник не пишет: чистый ник и закрепление решаются вторым запросом.
    const row = await this.prisma.account.upsert({
      where: { platform_platformUserId: key },
      create: {
        accountId: newAccountId,
        ...key,
        displayName: storedNameFor(identity.displayName, identity.username, newAccountId).name,
        platformName,
        username: identity.username,
        photoUrl: identity.photoUrl,
        createdAt: now,
        lastSeenAt: now,
      },
      update: {
        platformName,
        username: identity.username,
        ...(identity.photoUrl === undefined ? {} : { photoUrl: identity.photoUrl }),
        lastSeenAt: now,
      },
    });
    const created = row.createdAt.getTime() === now.getTime();

    // Чистый ник считается от id аккаунта (запасное «Игрок NNNN» постоянно для
    // него), а у найденного аккаунта id известен только после upsert — поэтому
    // два запроса, а не один. Закрепление проверяет сам UPDATE ... WHERE: сверка
    // с прочитанной строкой пропустила бы закрепление, поставленное в панели
    // между чтением и записью. Менять нечего — второго запроса нет.
    const cleanName = storedNameFor(identity.displayName, identity.username, row.accountId).name;
    if (row.nameLockedAt !== null || row.displayName === cleanName) return toAccount(row, created);
    const renamed = await this.prisma.account.updateMany({ where: { accountId: row.accountId, nameLockedAt: null }, data: { displayName: cleanName } });
    // Ноль строк — модератор закрепил ник в эту самую минуту: остаётся прежний.
    return toAccount(renamed.count === 0 ? row : { ...row, displayName: cleanName }, created);
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
  testerAt: Date | null;
  platformName: string | null;
  nameLockedAt: Date | null;
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
    testerAt: row.testerAt,
    platformName: row.platformName,
    nameLockedAt: row.nameLockedAt,
    created,
  };
}
