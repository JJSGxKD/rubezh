import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Окна перепроверки подписки после награды (`task_channel_watch`,
 * docs/35-stage4-plan.md Р115, tasks/T-0178): по строке на каждую выданную
 * награду за подписку, ключ — как у прогресса задания за срок. Запросы —
 * сырые, как у соседних таблиц модуля: частичный индекс и ограничения живут в
 * миграции, а не в схеме Prisma.
 *
 * Запись в окно идёт только по строкам в `watching`: повтор того же шага
 * после сбоя закрытое окно не меняет.
 */

export const WATCH_STATES = ["watching", "kept", "expired", "penalized"] as const;
/** `kept` — досидел окно, `expired` — окно кончилось без ответа площадки, `penalized` — отписался */
export type WatchState = (typeof WATCH_STATES)[number];

export interface WatchKey {
  accountId: string;
  taskId: string;
  /** начало срока награды, `YYYY-MM-DD` — как в `task_progress` */
  periodStart: string;
}

export interface NewWatch extends WatchKey {
  startedAt: Date;
  watchUntil: Date;
  nextCheckAt: Date;
}

/** Сколько списано по ресурсам награды: осколки — обычные. */
export interface Revoked {
  coins: number;
  gems: number;
  shards: number;
}

export interface WatchRow extends NewWatch {
  /** последняя проверка, на которую площадка ответила */
  checkedAt: Date | null;
  state: WatchState;
  /** номер события отписки пары; задан только у `penalized` */
  eventNo: number | null;
  penalizedAt: Date | null;
  revoked: Revoked | null;
}

/** Окно события отписки и сколько с него списано. */
export interface Penalty {
  key: WatchKey;
  revoked: Revoked;
}

export type PairLock<T> = { locked: true; value: T } | { locked: false };

export const CHANNEL_WATCH_REPOSITORY = Symbol("CHANNEL_WATCH_REPOSITORY");

export interface ChannelWatchRepository {
  /** завести окно; `false` — окно этой награды уже есть */
  start(row: NewWatch): Promise<boolean>;
  /** окна к проверке: `watching` с наступившим сроком, самые давние первыми */
  due(now: Date, limit: number): Promise<WatchRow[]>;
  /** все окна пары «игрок + задание» в `watching`, по сроку награды */
  openOf(accountId: string, taskId: string): Promise<WatchRow[]>;
  /** наибольший номер события отписки пары или 0 */
  lastEventNo(accountId: string, taskId: string): Promise<number>;
  /** отложить; `checkedAt: null` — площадка не ответила, прежняя отметка остаётся */
  postpone(keys: readonly WatchKey[], nextCheckAt: Date, checkedAt: Date | null): Promise<void>;
  close(keys: readonly WatchKey[], state: Extract<WatchState, "kept" | "expired">, closedAt: Date): Promise<void>;
  markPenalized(items: readonly Penalty[], eventNo: number, penalizedAt: Date): Promise<void>;
  /**
   * Выполнить `work`, пока никто другой не работает с этой парой, — на любой
   * реплике. Занято — `work` не вызывается и ответ `{ locked: false }`:
   * ждать незачем, окна подберёт следующий проход.
   */
  withPairLock<T>(accountId: string, taskId: string, work: () => Promise<T>): Promise<PairLock<T>>;
}

const revokedSchema = z.object({ coins: z.number().int().nonnegative(), gems: z.number().int().nonnegative(), shards: z.number().int().nonnegative() });

const rowSchema = z.object({
  account_id: z.string(),
  task_id: z.string(),
  period_start: z.string(),
  started_at: z.date(),
  watch_until: z.date(),
  next_check_at: z.date(),
  checked_at: z.date().nullable(),
  state: z.enum(WATCH_STATES),
  event_no: z.number().int().nullable(),
  penalized_at: z.date().nullable(),
  revoked: revokedSchema.nullable(),
});

/**
 * Замок пары держит открытую транзакцию, пока идёт работа: другие запросы
 * работы идут своими соединениями. Работа — списание, ограничение и запись в
 * ленту, всё в базе; площадку под замком не спрашивают (docs/15 §4.2).
 */
const LOCK_TX_OPTIONS = { maxWait: 5_000, timeout: 60_000 } as const;

function toRow(raw: unknown): WatchRow {
  const row = rowSchema.parse(raw);
  return {
    accountId: row.account_id,
    taskId: row.task_id,
    periodStart: row.period_start,
    startedAt: row.started_at,
    watchUntil: row.watch_until,
    nextCheckAt: row.next_check_at,
    checkedAt: row.checked_at,
    state: row.state,
    eventNo: row.event_no,
    penalizedAt: row.penalized_at,
    revoked: row.revoked,
  };
}

/** Ключи окон тремя столбцами: `unnest` в запросе сопоставляет их по номеру. */
function columns(keys: readonly WatchKey[]): { accounts: string[]; tasks: string[]; periods: string[] } {
  return { accounts: keys.map((key) => key.accountId), tasks: keys.map((key) => key.taskId), periods: keys.map((key) => key.periodStart) };
}

@Injectable()
export class PrismaChannelWatchRepository implements ChannelWatchRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async start(row: NewWatch): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO task_channel_watch (account_id, task_id, period_start, started_at, watch_until, next_check_at, state)
      VALUES (${row.accountId}::uuid, ${row.taskId}, ${row.periodStart}::date, ${row.startedAt}, ${row.watchUntil}, ${row.nextCheckAt}, 'watching')
      ON CONFLICT (account_id, task_id, period_start) DO NOTHING`;
    return inserted > 0;
  }

  async due(now: Date, limit: number): Promise<WatchRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, task_id, period_start::text AS period_start, started_at, watch_until, next_check_at, checked_at, state, event_no, penalized_at, revoked
      FROM task_channel_watch
      WHERE state = 'watching' AND next_check_at <= ${now}
      ORDER BY next_check_at, account_id, task_id, period_start
      LIMIT ${limit}`;
    return rows.map(toRow);
  }

  async openOf(accountId: string, taskId: string): Promise<WatchRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, task_id, period_start::text AS period_start, started_at, watch_until, next_check_at, checked_at, state, event_no, penalized_at, revoked
      FROM task_channel_watch
      WHERE account_id = ${accountId}::uuid AND task_id = ${taskId} AND state = 'watching'
      ORDER BY period_start`;
    return rows.map(toRow);
  }

  async lastEventNo(accountId: string, taskId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ last: number }[]>`
      SELECT COALESCE(max(event_no), 0)::int AS last FROM task_channel_watch WHERE account_id = ${accountId}::uuid AND task_id = ${taskId}`;
    return row?.last ?? 0;
  }

  async postpone(keys: readonly WatchKey[], nextCheckAt: Date, checkedAt: Date | null): Promise<void> {
    if (keys.length === 0) return;
    const { accounts, tasks, periods } = columns(keys);
    await this.prisma.$executeRaw`
      UPDATE task_channel_watch w SET next_check_at = ${nextCheckAt}, checked_at = COALESCE(${checkedAt}::timestamptz, w.checked_at)
      FROM unnest(${accounts}::uuid[], ${tasks}::text[], ${periods}::date[]) AS k(account_id, task_id, period_start)
      WHERE w.account_id = k.account_id AND w.task_id = k.task_id AND w.period_start = k.period_start AND w.state = 'watching'`;
  }

  async close(keys: readonly WatchKey[], state: Extract<WatchState, "kept" | "expired">, closedAt: Date): Promise<void> {
    if (keys.length === 0) return;
    const { accounts, tasks, periods } = columns(keys);
    // `kept` — ответ площадки «состоит» на исходе окна: это последняя проверка. `expired` ответа не имел.
    await this.prisma.$executeRaw`
      UPDATE task_channel_watch w SET state = ${state}, checked_at = CASE WHEN ${state}::text = 'kept' THEN ${closedAt}::timestamptz ELSE w.checked_at END
      FROM unnest(${accounts}::uuid[], ${tasks}::text[], ${periods}::date[]) AS k(account_id, task_id, period_start)
      WHERE w.account_id = k.account_id AND w.task_id = k.task_id AND w.period_start = k.period_start AND w.state = 'watching'`;
  }

  async markPenalized(items: readonly Penalty[], eventNo: number, penalizedAt: Date): Promise<void> {
    if (items.length === 0) return;
    const { accounts, tasks, periods } = columns(items.map((item) => item.key));
    const revoked = items.map((item) => JSON.stringify(item.revoked));
    // Ответ «не состоит» тоже ответ площадки — он и есть последняя проверка.
    await this.prisma.$executeRaw`
      UPDATE task_channel_watch w SET state = 'penalized', event_no = ${eventNo}, penalized_at = ${penalizedAt}, checked_at = ${penalizedAt}, revoked = k.revoked::jsonb
      FROM unnest(${accounts}::uuid[], ${tasks}::text[], ${periods}::date[], ${revoked}::text[]) AS k(account_id, task_id, period_start, revoked)
      WHERE w.account_id = k.account_id AND w.task_id = k.task_id AND w.period_start = k.period_start AND w.state = 'watching'`;
  }

  async withPairLock<T>(accountId: string, taskId: string, work: () => Promise<T>): Promise<PairLock<T>> {
    return await this.prisma.$transaction(async (tx): Promise<PairLock<T>> => {
      // Замок транзакции, без ожидания: занято — пару уже обрабатывает другой проход. Он снимается с
      // концом транзакции, в том числе при обрыве соединения, поэтому «повисшего» замка не бывает.
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`channel_watch:${accountId}:${taskId}`})) AS locked`;
      if (row?.locked !== true) return { locked: false };
      return { locked: true, value: await work() };
    }, LOCK_TX_OPTIONS);
  }
}
