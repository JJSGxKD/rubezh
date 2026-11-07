import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { sweepClickLaunches } from "./click-launch-sweep.js";
import { CONVERSION_WINDOWS, PAYMENT_CURRENCY, isConversionGoal, type ConversionGoal } from "./conversion-rules.js";
import { purgeDirectParams, sweepDirectLaunches } from "./direct-launch-sweep.js";
import { DESTINATION_KINDS, destinationOf, type DestinationKind } from "./destinations/destination.js";
import { TARGETS_CTE } from "./destinations/destination-targets.js";
import { KNOWN_GOALS, eventOfGoal, type PostbackEvent } from "./postback-events.js";

/**
 * Конверсии закупленной рекламы (`ad_conversion`, WP43).
 *
 * **Строки выводятся из фактов, а не из событий.** Проход раз в минуту
 * находит аккаунты, чьё первое касание — клик по ссылке сети, и их забеги и
 * оплаты, и дописывает недостающие конверсии. Упавший слушатель или
 * перезапуск не теряют конверсию: следующий проход её найдёт. Повтор прохода
 * ничего не задваивает — регистрацию и первую покупку держит уникальный
 * ключ на клик и назначение, любую покупку — ключ на оплату и назначение.
 *
 * Игрок — **новый аккаунт**: создан после клика. Старый игрок, заново
 * открывший игру по рекламе, сети не отдаётся — его привела не она.
 *
 * Запросы прохода живут в двух файлах: клики переходника — `click-launch-sweep.ts`.
 * Запуск по прямой ссылке на Mini App клика не оставляет: его конверсии
 * выводит `direct-launch-sweep.ts` из первого касания `link`, а метки сети
 * хранит сама строка.
 *
 * Кому и какие события отдавать, решает не этот файл, а набор
 * `destinations/destination-targets.ts` (T-0069): запросы прохода берут из
 * него назначения ссылки.
 */

export type ConversionStatus = "pending" | "sent" | "failed" | "skipped";

/** Конверсия к отправке: всё, что нужно назначению. */
export interface DueConversion {
  /** идентификатор события для приёмника: один на событие и назначение, при повторах не меняется */
  conversionId: string;
  destination: DestinationKind;
  event: PostbackEvent;
  attempts: number;
  params: Record<string, string> | null;
  /** Telegram ID игрока; `null` — игрок не из Telegram */
  telegramId: string | null;
  /** оплата событий-покупок; у остальных — `null` */
  purchase: { amount: number; currency: string } | null;
}

export interface ConversionRow {
  conversionId: string;
  /** код события в базе: 1–3 как `goaltype` AdsGram, 4 — возврат на следующий день */
  goal: number;
  event: PostbackEvent;
  destination: DestinationKind;
  status: ConversionStatus;
  reason: string | null;
  attempts: number;
  httpStatus: number | null;
  lastError: string | null;
  accountId: string;
  createdAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date;
}

/**
 * Курсор журнала — время и идентификатор: проход пишет пачку конверсий с
 * одним временем, и курсор по одному времени терял бы строки на стыке страниц.
 */
export interface JournalCursor {
  createdAt: Date;
  conversionId: string;
}

/** Счёт по цели: сколько отправлено, ждёт, не отправлено и пропущено. */
export type GoalCounts = Record<ConversionStatus, number>;
export type ConversionSummary = Record<ConversionGoal, GoalCounts>;

export const CONVERSIONS_REPOSITORY = Symbol("CONVERSIONS_REPOSITORY");

export interface ConversionsRepository {
  /** Дописать регистрации и покупки, которых ещё нет. Сколько дописано. */
  sweep(now: Date): Promise<{ registrations: number; purchases: number }>;
  due(now: Date, limit: number): Promise<DueConversion[]>;
  markSent(conversionId: string, httpStatus: number, now: Date): Promise<void>;
  /** Неудача: повторить в `nextAt` или, если `null`, — больше не пробовать. */
  markFailed(conversionId: string, attempts: number, nextAt: Date | null, httpStatus: number | null, error: string): Promise<void>;
  /** Отложить без попытки — нет токена кабинета. */
  defer(conversionId: string, nextAt: Date, reason: string): Promise<void>;
  /** Не отправлять вовсе — сети не узнать, чья это конверсия. */
  skip(conversionId: string, reason: string): Promise<void>;
  /** Обнулить макросы кликов и метки прямых запусков старше окна. Сколько обнулено. */
  purgeParams(now: Date, limit: number): Promise<number>;
  /** Счёт по ссылкам и целям назначения; строки других назначений в него не попадают. */
  summaries(linkCodes: readonly string[], destination?: DestinationKind): Promise<Map<string, ConversionSummary>>;
  /** Страница журнала, новые сверху; курсор — последняя строка прошлой страницы. */
  journal(linkCode: string, before: JournalCursor | null, limit: number): Promise<ConversionRow[]>;
  /** Отправить снова — неотправленную или аккаунт команды; `null` — такой у ссылки нет, она уже ушла или повтор её не отправит. */
  requeue(linkCode: string, conversionId: string, now: Date): Promise<ConversionRow | null>;
}

const paramsSchema = z.record(z.string(), z.string()).nullable().catch(null);

export function emptySummary(): ConversionSummary {
  const counts = (): GoalCounts => ({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  return { 1: counts(), 2: counts(), 3: counts() };
}

@Injectable()
export class PrismaConversionsRepository implements ConversionsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Кому и что отправлять. Точка подмены для теста: ветки назначений
   * проверяются на своём наборе, не трогая запросы прохода.
   */
  protected targets(): Prisma.Sql {
    return TARGETS_CTE;
  }

  async sweep(now: Date): Promise<{ registrations: number; purchases: number }> {
    const targets = this.targets();
    const clicks = await sweepClickLaunches(this.prisma, now, targets);
    const direct = await sweepDirectLaunches(this.prisma, now, targets);
    return { registrations: clicks.registrations + direct.registrations, purchases: clicks.purchases + direct.purchases };
  }

  async due(now: Date, limit: number): Promise<DueConversion[]> {
    // Коды и назначения, которых этот релиз не знает (строки новее кода при
    // откате), в очередь не попадают: иначе одна такая строка останавливала бы
    // проход, а читать её как регистрацию нельзя.
    const rows = await this.prisma.$queryRaw<
      { conversion_id: string; destination: string; goal: number; attempts: number; params: unknown; platform: string; platform_user_id: string; charged_stars: number | null }[]
    >`
      SELECT v.conversion_id, v.destination, v.goal, v.attempts, COALESCE(c.network_params, v.network_params) AS params, a.platform, a.platform_user_id, p.charged_stars
      FROM ad_conversion v
      LEFT JOIN link_click c ON c.click_id = v.click_id
      JOIN account a ON a.account_id = v.account_id
      LEFT JOIN purchase p ON p.purchase_id = v.purchase_id
      WHERE v.status = 'pending' AND v.next_attempt_at <= ${now}
        AND v.goal IN (${Prisma.join(KNOWN_GOALS)})
        AND v.destination IN (${Prisma.join(DESTINATION_KINDS)})
      ORDER BY v.next_attempt_at
      LIMIT ${limit}`;
    return rows.map((row) => ({
      conversionId: row.conversion_id,
      destination: destinationOf(row.destination),
      event: eventOfGoal(row.goal),
      attempts: row.attempts,
      params: paramsSchema.parse(row.params),
      telegramId: row.platform === "telegram" ? row.platform_user_id : null,
      purchase: row.charged_stars === null ? null : { amount: row.charged_stars, currency: PAYMENT_CURRENCY },
    }));
  }

  async markSent(conversionId: string, httpStatus: number, now: Date): Promise<void> {
    await this.prisma.adConversion.updateMany({
      where: { conversionId, status: "pending" },
      data: { status: "sent", sentAt: now, httpStatus, lastError: null, reason: null, attempts: { increment: 1 } },
    });
  }

  async markFailed(conversionId: string, attempts: number, nextAt: Date | null, httpStatus: number | null, error: string): Promise<void> {
    await this.prisma.adConversion.updateMany({
      where: { conversionId, status: "pending" },
      data: nextAt === null
        ? { status: "failed", attempts, httpStatus, lastError: error.slice(0, 200), reason: null }
        : { attempts, nextAttemptAt: nextAt, httpStatus, lastError: error.slice(0, 200), reason: null },
    });
  }

  async defer(conversionId: string, nextAt: Date, reason: string): Promise<void> {
    await this.prisma.adConversion.updateMany({ where: { conversionId, status: "pending" }, data: { nextAttemptAt: nextAt, reason } });
  }

  async skip(conversionId: string, reason: string): Promise<void> {
    await this.prisma.adConversion.updateMany({ where: { conversionId, status: "pending" }, data: { status: "skipped", reason } });
  }

  async purgeParams(now: Date, limit: number): Promise<number> {
    const clicks = await this.prisma.$executeRaw`
      UPDATE link_click SET network_params = NULL
      WHERE click_id IN (
        SELECT click_id FROM link_click
        WHERE network_params IS NOT NULL AND at < ${now}::timestamptz - make_interval(days => ${CONVERSION_WINDOWS.paramsKeepDays})
        LIMIT ${limit}
      )`;
    const conversions = await purgeDirectParams(this.prisma, now, limit);
    return clicks + conversions;
  }

  async summaries(linkCodes: readonly string[], destination: DestinationKind = "adsgram"): Promise<Map<string, ConversionSummary>> {
    const result = new Map<string, ConversionSummary>();
    if (linkCodes.length === 0) return result;
    const rows = await this.prisma.$queryRaw<{ link_code: string; goal: number; status: ConversionStatus; count: number }[]>`
      SELECT link_code, goal, status, count(*)::int AS count
      FROM ad_conversion
      WHERE link_code IN (${Prisma.join(linkCodes)}) AND destination = ${destination}
      GROUP BY link_code, goal, status`;
    for (const row of rows) {
      // Счёт — по трём целям сети; события, которых у неё нет, в нём не считаются.
      if (!isConversionGoal(row.goal)) continue;
      const summary = result.get(row.link_code) ?? emptySummary();
      summary[row.goal][row.status] = row.count;
      result.set(row.link_code, summary);
    }
    return result;
  }

  async journal(linkCode: string, before: JournalCursor | null, limit: number): Promise<ConversionRow[]> {
    const after =
      before === null ? {} : { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, conversionId: { lt: before.conversionId } }] };
    const rows = await this.prisma.adConversion.findMany({
      where: { linkCode, ...after },
      orderBy: [{ createdAt: "desc" }, { conversionId: "desc" }],
      take: limit,
    });
    return rows.map(rowOf);
  }

  async requeue(linkCode: string, conversionId: string, now: Date): Promise<ConversionRow | null> {
    const { count } = await this.prisma.adConversion.updateMany({
      // Пропущенная без меток сети пропустилась бы снова — повторить можно
      // только неотправленную и аккаунт команды (проверка связки с кабинетом).
      where: { conversionId, linkCode, OR: [{ status: "failed" }, { status: "skipped", reason: "team" }] },
      data: { status: "pending", attempts: 0, nextAttemptAt: now, reason: null, lastError: null, httpStatus: null },
    });
    if (count === 0) return null;
    const row = await this.prisma.adConversion.findUnique({ where: { conversionId } });
    return row === null ? null : rowOf(row);
  }
}

function rowOf(row: {
  conversionId: string;
  goal: number;
  destination: string;
  status: ConversionStatus;
  reason: string | null;
  attempts: number;
  httpStatus: number | null;
  lastError: string | null;
  accountId: string;
  createdAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date;
}): ConversionRow {
  return { ...row, event: eventOfGoal(row.goal), destination: destinationOf(row.destination) };
}
