import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { CONVERSION_WINDOWS, type ConversionGoal } from "./conversion-rules.js";

/**
 * Конверсии закупленной рекламы (`ad_conversion`, WP43).
 *
 * **Строки выводятся из фактов, а не из событий.** Проход раз в минуту
 * находит аккаунты, чьё первое касание — клик по ссылке сети, и их забеги и
 * оплаты, и дописывает недостающие конверсии. Упавший слушатель или
 * перезапуск не теряют конверсию: следующий проход её найдёт. Повтор прохода
 * ничего не задваивает — регистрацию и первую покупку держит уникальный
 * ключ на клик, любую покупку — ключ на оплату.
 *
 * Игрок — **новый аккаунт**: создан после клика. Старый игрок, заново
 * открывший игру по рекламе, сети не отдаётся — его привела не она.
 */

export type ConversionStatus = "pending" | "sent" | "failed" | "skipped";

/** Конверсия к отправке: всё, что нужно постбэку. */
export interface DueConversion {
  conversionId: string;
  network: string;
  goal: ConversionGoal;
  attempts: number;
  params: Record<string, string> | null;
  /** Telegram ID игрока; `null` — игрок не из Telegram */
  telegramId: string | null;
}

export interface ConversionRow {
  conversionId: string;
  goal: ConversionGoal;
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
  /** Обнулить макросы кликов старше окна. Сколько обнулено. */
  purgeParams(now: Date, limit: number): Promise<number>;
  summaries(linkCodes: readonly string[]): Promise<Map<string, ConversionSummary>>;
  /** Страница журнала, новые сверху; курсор — последняя строка прошлой страницы. */
  journal(linkCode: string, before: JournalCursor | null, limit: number): Promise<ConversionRow[]>;
  /** Отправить снова — неотправленную или аккаунт команды; `null` — такой у ссылки нет, она уже ушла или повтор её не отправит. */
  requeue(linkCode: string, conversionId: string, now: Date): Promise<ConversionRow | null>;
}

const paramsSchema = z.record(z.string(), z.string()).nullable().catch(null);
const goalOf = (value: number): ConversionGoal => (value === 2 ? 2 : value === 3 ? 3 : 1);

export function emptySummary(): ConversionSummary {
  const counts = (): GoalCounts => ({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  return { 1: counts(), 2: counts(), 3: counts() };
}

@Injectable()
export class PrismaConversionsRepository implements ConversionsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async sweep(now: Date): Promise<{ registrations: number; purchases: number }> {
    const { registrationDays, purchaseDays, purchaseSettleMin, minRunSec } = CONVERSION_WINDOWS;
    // Кандидаты — по первому касанию за окно: индекс `(first_start_kind, first_at)`.
    // Аккаунт команды конверсией не становится: свои проверки сети не нужны —
    // строка пишется пропущенной, отправить её можно руками.
    const registrations = await this.prisma.$executeRaw`
      INSERT INTO ad_conversion (conversion_id, network, link_code, click_id, account_id, goal, status, reason, next_attempt_at, created_at)
      SELECT gen_random_uuid(), l.network, l.code, c.click_id, q.account_id, 1,
             (CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) THEN 'skipped' ELSE 'pending' END)::ad_conversion_status,
             CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) THEN 'team' END,
             ${now}, ${now}
      FROM acquisition q
      JOIN link_click c ON c.click_id = q.first_start_ref
      JOIN link l ON l.code = c.link_code AND l.network IS NOT NULL
      JOIN account a ON a.account_id = q.account_id AND a.created_at >= c.at - interval '1 minute'
      WHERE q.first_start_kind = 'click'
        AND q.first_at > ${now}::timestamptz - make_interval(days => ${registrationDays + 1})
        AND (
          l.registration_on = 'launch'
          OR EXISTS (
            SELECT 1 FROM run r
            WHERE r.account_id = q.account_id
              AND r.finished_at IS NOT NULL
              AND r.finished_at <= c.at + make_interval(days => ${registrationDays})
              AND r.cheats = false
              AND r.survival_sec >= ${minRunSec}
              AND (r.verdict IS NULL OR r.verdict <> 'rejected')
          )
        )
      ON CONFLICT DO NOTHING`;

    // Покупки — настоящие, не возвращённые, отлежавшиеся. Номер покупки —
    // среди таких же по времени оплаты: первая — цель 2, остальные — 3.
    const purchases = await this.prisma.$executeRaw`
      WITH attributed AS (
        SELECT q.account_id, c.click_id, c.at AS click_at, l.code AS link_code, l.network
        FROM acquisition q
        JOIN link_click c ON c.click_id = q.first_start_ref
        JOIN link l ON l.code = c.link_code AND l.network IS NOT NULL
        JOIN account a ON a.account_id = q.account_id AND a.created_at >= c.at - interval '1 minute'
        WHERE q.first_start_kind = 'click'
          AND q.first_at > ${now}::timestamptz - make_interval(days => ${purchaseDays + 1})
      ),
      paid AS (
        SELECT p.purchase_id, p.account_id, p.paid_at,
               row_number() OVER (PARTITION BY p.account_id ORDER BY p.paid_at, p.purchase_id) AS n
        FROM purchase p
        JOIN attributed t ON t.account_id = p.account_id
        WHERE p.mode = 'live' AND p.paid_at IS NOT NULL AND p.status = 'paid' AND p.refund_requested_at IS NULL
      )
      INSERT INTO ad_conversion (conversion_id, network, link_code, click_id, account_id, goal, purchase_id, status, reason, next_attempt_at, created_at)
      SELECT gen_random_uuid(), t.network, t.link_code, t.click_id, t.account_id,
             CASE WHEN paid.n = 1 THEN 2 ELSE 3 END, paid.purchase_id,
             (CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = t.account_id) THEN 'skipped' ELSE 'pending' END)::ad_conversion_status,
             CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = t.account_id) THEN 'team' END,
             ${now}, ${now}
      FROM paid
      JOIN attributed t ON t.account_id = paid.account_id
      WHERE paid.paid_at <= t.click_at + make_interval(days => ${purchaseDays})
        AND paid.paid_at <= ${now}::timestamptz - make_interval(mins => ${purchaseSettleMin})
      ON CONFLICT DO NOTHING`;
    return { registrations, purchases };
  }

  async due(now: Date, limit: number): Promise<DueConversion[]> {
    const rows = await this.prisma.$queryRaw<{ conversion_id: string; network: string; goal: number; attempts: number; params: unknown; platform: string; platform_user_id: string }[]>`
      SELECT v.conversion_id, v.network, v.goal, v.attempts, c.network_params AS params, a.platform, a.platform_user_id
      FROM ad_conversion v
      JOIN link_click c ON c.click_id = v.click_id
      JOIN account a ON a.account_id = v.account_id
      WHERE v.status = 'pending' AND v.next_attempt_at <= ${now}
      ORDER BY v.next_attempt_at
      LIMIT ${limit}`;
    return rows.map((row) => ({
      conversionId: row.conversion_id,
      network: row.network,
      goal: goalOf(row.goal),
      attempts: row.attempts,
      params: paramsSchema.parse(row.params),
      telegramId: row.platform === "telegram" ? row.platform_user_id : null,
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
    return await this.prisma.$executeRaw`
      UPDATE link_click SET network_params = NULL
      WHERE click_id IN (
        SELECT click_id FROM link_click
        WHERE network_params IS NOT NULL AND at < ${now}::timestamptz - make_interval(days => ${CONVERSION_WINDOWS.paramsKeepDays})
        LIMIT ${limit}
      )`;
  }

  async summaries(linkCodes: readonly string[]): Promise<Map<string, ConversionSummary>> {
    const result = new Map<string, ConversionSummary>();
    if (linkCodes.length === 0) return result;
    const rows = await this.prisma.$queryRaw<{ link_code: string; goal: number; status: ConversionStatus; count: number }[]>`
      SELECT link_code, goal, status, count(*)::int AS count
      FROM ad_conversion
      WHERE link_code IN (${Prisma.join(linkCodes)})
      GROUP BY link_code, goal, status`;
    for (const row of rows) {
      const summary = result.get(row.link_code) ?? emptySummary();
      summary[goalOf(row.goal)][row.status] = row.count;
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
  return { ...row, goal: goalOf(row.goal) };
}
