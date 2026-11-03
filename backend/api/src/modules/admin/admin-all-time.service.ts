import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { pickRecord, windowOf } from "../admin-notify/activity-snapshot.js";
import { teamDay } from "../admin-notify/daily-stats.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { ALL_TIME_REPOSITORY, ALL_TIME_STORE, type AccountsRow, type AllTimeRepository, type AllTimeStore, type RecordRow } from "./admin-all-time.repository.js";

/**
 * «Чего достигли» — итоги за всё время для сводки панели (tasks/T-0203):
 * аккаунты и кому из них можно писать, сколько человек играло, доход в
 * звёздах и рекорды DAU/WAU/MAU. Рекорды — максимум по суточным снимкам
 * (`activity_daily`) и по сегодняшним, ещё не закрытым суткам.
 *
 * Агрегаты по всей базе тяжёлые, а смотрят их редко: полный ответ лежит в
 * Redis пять минут одним ключом, пересчёт идёт под замком — пока он у
 * соседней реплики, остальные ждут её результата, а не бегут в базу.
 * Доход режется по праву уже **после** кеша: в кеше полный ответ, права
 * смотрятся на каждый запрос.
 */

/** Ключ, срок и замок — константы кода, без релиза не меняются (docs/30-configuration-map.md §5). */
export const ALL_TIME_KEY = "admin:all-time:v1";
export const ALL_TIME_LOCK_KEY = "admin:all-time:v1:lock";
export const ALL_TIME_TTL_SEC = 300;
/** Пересчёт укладывается в срок запросов; замок страхует от упавшей реплики, а не от медленной. */
export const ALL_TIME_LOCK_TTL_SEC = 30;
/** Сколько ждать результата соседа и как часто заглядывать в кеш. */
export const ALL_TIME_WAIT_MS = 5_000;
export const ALL_TIME_POLL_MS = 250;
const READ_TIMEOUT_MS = 20_000;

export interface PlatformTotal {
  platform: (typeof PLATFORM_IDS)[number];
  total: number;
}

export interface AllTimeRecord {
  value: number;
  /** сутки рекорда по Москве, `2026-10-14` */
  day: string;
  /** сегодняшнее живое число */
  now: number;
}

export interface AllTime {
  /** когда посчитано — кеш старше минуты это видно */
  at: string;
  accounts: { total: number; banned: number; byPlatform: PlatformTotal[] };
  reachable: { total: number; byPlatform: PlatformTotal[] };
  played: { players: number; runs: number };
  /** `null` — нет права `analytics.revenue.view` */
  revenue: { stars: number; paid: number; refunded: number; purchases: number; donations: number } | null;
  /** `null` — снимков нет и сегодня никого */
  records: Record<"dau" | "wau" | "mau", AllTimeRecord | null>;
}

const platformTotals = z.array(z.object({ platform: z.enum(PLATFORM_IDS), total: z.number() }));
const recordSchema = z.object({ value: z.number(), day: z.string(), now: z.number() }).nullable();
/** Форма кеша: запись другой версии или чужая не должна дойти до панели как есть. */
const cachedSchema = z.object({
  at: z.string(),
  accounts: z.object({ total: z.number(), banned: z.number(), byPlatform: platformTotals }),
  reachable: z.object({ total: z.number(), byPlatform: platformTotals }),
  played: z.object({ players: z.number(), runs: z.number() }),
  revenue: z.object({ stars: z.number(), paid: z.number(), refunded: z.number(), purchases: z.number(), donations: z.number() }).nullable(),
  records: z.object({ dau: recordSchema, wau: recordSchema, mau: recordSchema }),
});

@Injectable()
export class AdminAllTimeService {
  private readonly logger = new Logger("admin-all-time");
  /** Пересчёт этой реплики: параллельные запросы делят его, а не умножают нагрузку на базу. */
  private inflight: Promise<AllTime> | null = null;

  constructor(
    @Inject(ALL_TIME_REPOSITORY) private readonly repository: AllTimeRepository,
    @Inject(ALL_TIME_STORE) private readonly store: AllTimeStore,
    private readonly roles: RolesService,
  ) {}

  async allTime(actor: AccountRef, now = new Date()): Promise<AllTime> {
    await this.roles.require(actor, "analytics.gameplay.view");
    const full = await this.full(now);
    const revenue = (await this.roles.can(actor, "analytics.revenue.view")) ? full.revenue : null;
    return { ...full, revenue };
  }

  private async full(now: Date): Promise<AllTime> {
    const cached = await this.cached();
    if (cached !== null) return cached;
    this.inflight ??= this.refresh(now).finally(() => {
      this.inflight = null;
    });
    return await this.inflight;
  }

  /**
   * Пересчёт под замком. Замок занят — ждём результат соседа, заглядывая в
   * кеш и в замок раз в 250 мс: упал сосед — замок освободится, и считать
   * будем мы. Не дождались за 5 секунд — считаем сами: панель важнее
   * экономии. Redis недоступен — то же самое сразу, без ожидания и без кеша.
   */
  private async refresh(now: Date): Promise<AllTime> {
    const token = randomUUID();
    let lock = await this.lock(token);
    // Ожидание считается опросами, а не часами: оно не должно зависеть от времени, потраченного на сам пересчёт.
    for (let waited = 0; lock === "busy" && waited < ALL_TIME_WAIT_MS; waited += ALL_TIME_POLL_MS) {
      await sleep(ALL_TIME_POLL_MS);
      const ready = await this.cached();
      if (ready !== null) return ready;
      lock = await this.lock(token);
    }
    if (lock === "held") return await this.recount(now, token);
    const fresh = await this.compute(now);
    // Сосед не успел или упал: результат кладём в кеш и мы, иначе каждый следующий запрос ждал бы пять секунд и считал заново.
    if (lock === "busy") await this.remember(fresh);
    return fresh;
  }

  /** Замок взят: сосед мог положить результат между нашим промахом по кешу и замком. */
  private async recount(now: Date, token: string): Promise<AllTime> {
    try {
      const ready = await this.cached();
      if (ready !== null) return ready;
      const fresh = await this.compute(now);
      await this.remember(fresh);
      return fresh;
    } finally {
      await this.release(token);
    }
  }

  private async compute(now: Date): Promise<AllTime> {
    const today = teamDay(now.getTime());
    const read = <T>(promise: Promise<T>, what: string): Promise<T> => withTimeout(promise, READ_TIMEOUT_MS, `итоги: ${what}`);
    // Две волны, а не всё сразу: пул соединений общий с играющими, и пересчёт не должен занимать его целиком.
    const [accounts, runs, revenue] = await Promise.all([
      read(this.repository.accounts(), "аккаунты"),
      read(this.repository.runs(), "забеги"),
      read(this.repository.revenue(), "доход"),
    ]);
    const [snapshots, dayNow, weekNow, monthNow] = await Promise.all([
      read(this.repository.records(), "рекорды"),
      read(this.repository.activeIn(windowOf(today, 1)), "сегодняшний DAU"),
      read(this.repository.activeIn(windowOf(today, 7)), "сегодняшний WAU"),
      read(this.repository.activeIn(windowOf(today, 30)), "сегодняшний MAU"),
    ]);
    return {
      at: now.toISOString(),
      accounts: { total: sum(accounts, "total"), banned: sum(accounts, "banned"), byPlatform: byPlatform(accounts, "total") },
      reachable: { total: sum(accounts, "reachable"), byPlatform: byPlatform(accounts, "reachable") },
      played: { players: runs.players, runs: runs.runs },
      revenue: { stars: revenue.paid - revenue.refunded, paid: revenue.paid, refunded: revenue.refunded, purchases: revenue.purchases, donations: revenue.donations },
      records: {
        dau: recordOf(snapshots.dau, today, dayNow),
        wau: recordOf(snapshots.wau, today, weekNow),
        mau: recordOf(snapshots.mau, today, monthNow),
      },
    };
  }

  /** Кеш не ответил, пуст или не той формы — как пустой: ответ посчитают заново. */
  private async cached(): Promise<AllTime | null> {
    let raw: string | null;
    try {
      raw = await this.store.get(ALL_TIME_KEY);
    } catch (error: unknown) {
      this.warn("cache_unavailable", error);
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = cachedSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      this.warn("cache_invalid", new Error("форма записи не совпала со схемой"));
    } catch (error: unknown) {
      this.warn("cache_invalid", error);
    }
    return null;
  }

  private async remember(value: AllTime): Promise<void> {
    try {
      await this.store.set(ALL_TIME_KEY, JSON.stringify(value), ALL_TIME_TTL_SEC);
    } catch (error: unknown) {
      this.warn("cache_not_saved", error);
    }
  }

  /** `unavailable` — Redis не ответил: замок взять негде, и считать придётся без него. */
  private async lock(token: string): Promise<"held" | "busy" | "unavailable"> {
    try {
      return (await this.store.acquire(ALL_TIME_LOCK_KEY, token, ALL_TIME_LOCK_TTL_SEC)) ? "held" : "busy";
    } catch (error: unknown) {
      this.warn("lock_unavailable", error);
      return "unavailable";
    }
  }

  private async release(token: string): Promise<void> {
    try {
      await this.store.release(ALL_TIME_LOCK_KEY, token);
    } catch (error: unknown) {
      // Замок сам истечёт через 30 секунд.
      this.warn("lock_not_released", error);
    }
  }

  private warn(event: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "admin-all-time", event, reason: error instanceof Error ? error.message : "unknown" }));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sum(rows: readonly AccountsRow[], field: "total" | "banned" | "reachable"): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

/** Площадки по убыванию, при равенстве — по имени: порядок не зависит от ответа базы. */
function byPlatform(rows: readonly AccountsRow[], field: "total" | "reachable"): PlatformTotal[] {
  return rows
    .map((row) => ({ platform: row.platform, total: row[field] }))
    .sort((a, b) => b.total - a.total || a.platform.localeCompare(b.platform));
}

/**
 * Рекорд показателя: лучшее из снимка и сегодняшнего живого числа. Нулевое
 * значение рекордом не считается — «лучшие сутки без единого игрока» ничего
 * не говорят.
 */
function recordOf(snapshot: RecordRow | null, today: string, live: number): AllTimeRecord | null {
  const points = [...(snapshot === null ? [] : [snapshot]), { day: today, value: live }].filter((point) => point.value > 0);
  const best = pickRecord(points);
  return best === null ? null : { ...best, now: live };
}
