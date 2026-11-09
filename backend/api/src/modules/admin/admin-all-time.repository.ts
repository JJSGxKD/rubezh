import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { REDIS } from "../../infra/redis.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import type { ActivityWindow } from "../admin-notify/activity-snapshot.js";
import { DONATION_PRODUCT } from "../payments/purchase-types.js";

/**
 * Чтения для панели «Чего достигли» и для ночного снимка аудитории
 * (tasks/T-0203): итоги за всё время агрегатами по базе и кеш в Redis.
 *
 * Запросы — «сырой» SQL, ответ разбирается схемой. Тяжёлые из них идут редко:
 * сервис держит результат пять минут под замком (`admin-all-time.service.ts`),
 * а снимок суток — раз в ночь. Потолок времени запроса — общий для пула
 * (`statement_timeout`, `infra/database.ts`).
 */

export const ALL_TIME_REPOSITORY = Symbol("ALL_TIME_REPOSITORY");
export const ALL_TIME_STORE = Symbol("ALL_TIME_STORE");

/** Аккаунты одной площадки: всего, заблокированных и тех, кому боту можно писать. */
export interface AccountsRow {
  platform: PlatformId;
  total: number;
  banned: number;
  reachable: number;
}

export interface RunsRow {
  /** законченные забеги без читов */
  runs: number;
  /** разных аккаунтов среди них */
  players: number;
}

export interface RevenueRow {
  /** звёзды живых оплат */
  paid: number;
  /** звёзды возвращённых оплат */
  refunded: number;
  /** число оплаченных живых покупок */
  purchases: number;
  donations: number;
}

/** Лучшие сутки показателя в снимках. */
export interface RecordRow {
  day: string;
  value: number;
}

export interface Records {
  dau: RecordRow | null;
  wau: RecordRow | null;
  mau: RecordRow | null;
}

/** Что нужно ночному заданию снимка. */
export interface ActivitySnapshotRepository {
  /** Последние закрытые сутки или `null`, пока таблица пуста. */
  lastClosedDay(): Promise<string | null>;
  /** Момент самой ранней сессии запуска или `null`, пока сессий нет. */
  firstSessionAt(): Promise<Date | null>;
  /** Сколько разных аккаунтов запускало игру в окне `[from, to)`. */
  activeIn(window: ActivityWindow): Promise<number>;
  /** Запись суток; `false` — они уже записаны (соседней репликой), строка не тронута. */
  insertDay(day: string, dau: number, wau: number, mau: number): Promise<boolean>;
}

export interface AllTimeRepository extends ActivitySnapshotRepository {
  accounts(): Promise<AccountsRow[]>;
  runs(): Promise<RunsRow>;
  revenue(): Promise<RevenueRow>;
  records(): Promise<Records>;
}

/**
 * Кеш итогов в Redis: значение со сроком и замок пересчёта. Замок снимается
 * только своим токеном — иначе реплика, чей замок успел истечь, сняла бы
 * замок соседа.
 */
export interface AllTimeStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** `SET NX EX`: `true` — замок взят. */
  acquire(key: string, token: string, ttlSec: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

const count = z.coerce.number().int().nonnegative();
const platformSchema = z.enum(PLATFORM_IDS);
const accountsSchema = z.array(z.object({ platform: platformSchema, total: count, banned: count, reachable: count }));
const runsSchema = z.array(z.object({ runs: count, players: count }));
const revenueSchema = z.array(z.object({ paid: count, refunded: count, purchases: count, donations: count }));
const recordSchema = z.array(z.object({ day: z.string(), value: count }));
const activeSchema = z.array(z.object({ active: count }));
const lastDaySchema = z.array(z.object({ day: z.string().nullable() }));
const firstSessionSchema = z.array(z.object({ at: z.coerce.date().nullable() }));

/** Только то, что читает репозиторий: клиент Prisma и его транзакция подходят одинаково. */
type SqlClient = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

@Injectable()
export class PrismaAllTimeRepository implements AllTimeRepository {
  constructor(@Inject(PRISMA) private readonly prisma: SqlClient) {}

  async accounts(): Promise<AccountsRow[]> {
    // Аккаунт без строки в `account_messaging` писать нельзя: `LEFT JOIN` даёт NULL, а `FILTER` его отсекает.
    const rows = await this.prisma.$queryRaw`
      SELECT a.platform::text AS platform,
             count(*) AS total,
             count(*) FILTER (WHERE a.banned_at IS NOT NULL) AS banned,
             count(*) FILTER (WHERE m.can_message) AS reachable
      FROM account a LEFT JOIN account_messaging m ON m.account_id = a.account_id
      GROUP BY 1`;
    return accountsSchema.parse(rows);
  }

  async runs(): Promise<RunsRow> {
    // Забег с читами — разработчика: игроков в итоги он не добавляет, как в сводке и отчёте.
    const rows = await this.prisma.$queryRaw`
      SELECT count(*) AS runs, count(DISTINCT account_id) AS players
      FROM run WHERE status = 'finished' AND NOT cheats`;
    return runsSchema.parse(rows)[0] ?? { runs: 0, players: 0 };
  }

  async revenue(): Promise<RevenueRow> {
    // «Покупки» — без донатов, как в отчёте и сводке (Р109); звёзды — все живые оплаты, донаты тоже.
    // Тестовая оплата — одна звезда на проверку, в выручку не идёт; возвращённая оплата входит в обе суммы.
    const rows = await this.prisma.$queryRaw`
      SELECT coalesce(sum(charged_stars) FILTER (WHERE paid_at IS NOT NULL), 0) AS paid,
             coalesce(sum(charged_stars) FILTER (WHERE refunded_at IS NOT NULL), 0) AS refunded,
             count(*) FILTER (WHERE paid_at IS NOT NULL AND product::text <> ${DONATION_PRODUCT}) AS purchases,
             count(*) FILTER (WHERE paid_at IS NOT NULL AND product::text = ${DONATION_PRODUCT}) AS donations
      FROM purchase WHERE mode = 'live'`;
    return revenueSchema.parse(rows)[0] ?? { paid: 0, refunded: 0, purchases: 0, donations: 0 };
  }

  async records(): Promise<Records> {
    // Таблица — по строке на сутки, тысячи строк за годы: три выбора максимума дешевле индексов по каждому полю.
    // При равенстве — более ранние сутки.
    const first = async (rows: Promise<unknown>): Promise<RecordRow | null> => recordSchema.parse(await rows)[0] ?? null;
    return {
      dau: await first(this.prisma.$queryRaw`SELECT day, dau AS value FROM activity_daily ORDER BY dau DESC, day ASC LIMIT 1`),
      wau: await first(this.prisma.$queryRaw`SELECT day, wau AS value FROM activity_daily ORDER BY wau DESC, day ASC LIMIT 1`),
      mau: await first(this.prisma.$queryRaw`SELECT day, mau AS value FROM activity_daily ORDER BY mau DESC, day ASC LIMIT 1`),
    };
  }

  async activeIn({ from, to }: ActivityWindow): Promise<number> {
    const rows = await this.prisma.$queryRaw`
      SELECT count(DISTINCT account_id) AS active FROM account_session WHERE started_at >= ${from} AND started_at < ${to}`;
    return activeSchema.parse(rows)[0]?.active ?? 0;
  }

  async lastClosedDay(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw`SELECT max(day) AS day FROM activity_daily`;
    return lastDaySchema.parse(rows)[0]?.day ?? null;
  }

  async firstSessionAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw`SELECT min(started_at) AS at FROM account_session`;
    return firstSessionSchema.parse(rows)[0]?.at ?? null;
  }

  async insertDay(day: string, dau: number, wau: number, mau: number): Promise<boolean> {
    // Повтор безопасен: две реплики или два прохода закрывают одни сутки одними числами.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO activity_daily (day, dau, wau, mau) VALUES (${day}, ${dau}, ${wau}, ${mau}) ON CONFLICT (day) DO NOTHING`;
    return inserted > 0;
  }
}

const REDIS_TIMEOUT_MS = 2_000;

/** Снимает замок, только если в нём ещё наш токен. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class RedisAllTimeStore implements AllTimeStore {
  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, "get" | "set" | "eval">) {}

  async get(key: string): Promise<string | null> {
    return await withTimeout(this.redis.get(key), REDIS_TIMEOUT_MS, "итоги: чтение кеша");
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await withTimeout(this.redis.set(key, value, "EX", ttlSec), REDIS_TIMEOUT_MS, "итоги: запись кеша");
  }

  async acquire(key: string, token: string, ttlSec: number): Promise<boolean> {
    return (await withTimeout(this.redis.set(key, token, "EX", ttlSec, "NX"), REDIS_TIMEOUT_MS, "итоги: замок")) !== null;
  }

  async release(key: string, token: string): Promise<void> {
    await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, key, token) as Promise<unknown>, REDIS_TIMEOUT_MS, "итоги: снятие замка");
  }
}
