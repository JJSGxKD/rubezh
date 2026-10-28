import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Отчёт «Нажатия» (docs/35-stage4-plan.md, Р141; tasks/T-0228): на каждом
 * экране — какие кнопки нажимают и какая доля открывших экран нажала каждую.
 * Читает `ui_clicked` и `screen_viewed` из `analytics_event`; игроки считаются
 * по `install_id`, но наружу идут только счётчики.
 *
 * Период — по `occurred_at`, а по `received_at` — с запасом в сутки после
 * конца: клиент присылает события пачкой позже, и индекс
 * `(event_type, received_at)` режет выборку раньше, чем `occurred_at`.
 */

/** Запас по времени приёма после конца периода: пачка с устройства приходит позже самого события. */
const RECEIVE_LAG = "1 day";
/** Экранов и кнопок в игре заведомо меньше; предел — защита от мусора в payload, а не срез данных. */
const MAX_ROWS = 300;

export interface UiClickCount {
  control: string;
  /** сколько раз нажали */
  clicks: number;
  /** сколько разных игроков нажало */
  players: number;
}

export interface UiClickRow extends UiClickCount {
  /** доля открывших экран, нажавших хотя бы раз, в процентах с десятыми; `null` — экран не открывали */
  share: number | null;
}

export interface UiClicksReport {
  /** игроков, открывших экран за период */
  opened: number;
  rows: UiClickRow[];
}

export interface UiScreenRow {
  screen: string;
  /** игроков, открывших экран */
  players: number;
  /** открытий всего */
  views: number;
}

export interface UiClicksQuery {
  screen: string;
  from: Date;
  to: Date;
  /** `null` — все площадки */
  platform: string | null;
}

/**
 * Доля нажавших от открывших, проценты с десятыми. Нажали, не открыв (событие
 * открытия потерялось), — доля упирается в 100: больше «всех» быть не может.
 */
export function sharePercent(players: number, opened: number): number | null {
  if (opened <= 0) return null;
  return Math.min(100, Math.round((players * 1000) / opened) / 10);
}

/** Строки таблицы: самые нажимаемые кнопки сверху, при равенстве — по имени. */
export function buildUiClickRows(counts: readonly UiClickCount[], opened: number): UiClickRow[] {
  return counts
    .map((count) => ({ control: count.control, clicks: count.clicks, players: count.players, share: sharePercent(count.players, opened) }))
    .sort((a, b) => b.clicks - a.clicks || a.control.localeCompare(b.control));
}

/** Счёты база отдаёт `bigint`. */
const numeric = z.union([z.number(), z.bigint()]).transform(Number);

const clickRowSchema = z.object({ control: z.string(), clicks: numeric, players: numeric });
const openedRowSchema = z.object({ players: numeric });
const screenRowSchema = z.object({ screen: z.string(), players: numeric, views: numeric });

export async function uiClicksReport(prisma: PrismaClient, query: UiClicksQuery): Promise<UiClicksReport> {
  const [clickRows, openedRows] = await Promise.all([
    prisma.$queryRawUnsafe<unknown[]>(
      `SELECT payload->>'control' AS control, count(*) AS clicks, count(DISTINCT install_id) AS players
       FROM analytics_event
       WHERE event_type = 'ui_clicked'
         AND received_at >= $1 AND received_at < $2::timestamptz + interval '${RECEIVE_LAG}'
         AND occurred_at >= $1 AND occurred_at < $2
         AND payload->>'screen' = $3
         AND ($4::text IS NULL OR platform::text = $4)
       GROUP BY 1
       LIMIT ${MAX_ROWS}`,
      query.from,
      query.to,
      query.screen,
      query.platform,
    ),
    prisma.$queryRawUnsafe<unknown[]>(
      `SELECT count(DISTINCT install_id) AS players
       FROM analytics_event
       WHERE event_type = 'screen_viewed'
         AND received_at >= $1 AND received_at < $2::timestamptz + interval '${RECEIVE_LAG}'
         AND occurred_at >= $1 AND occurred_at < $2
         AND payload->>'screen' = $3
         AND ($4::text IS NULL OR platform::text = $4)`,
      query.from,
      query.to,
      query.screen,
      query.platform,
    ),
  ]);
  const opened = openedRows.length === 0 ? 0 : openedRowSchema.parse(openedRows[0]).players;
  return { opened, rows: buildUiClickRows(clickRows.map((raw) => clickRowSchema.parse(raw)), opened) };
}

/** Экраны, которые открывали за период, — по убыванию числа открывших: от этого списка выбирают экран. */
export async function uiScreensReport(prisma: PrismaClient, from: Date, to: Date, platform: string | null): Promise<UiScreenRow[]> {
  const rows = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT payload->>'screen' AS screen, count(DISTINCT install_id) AS players, count(*) AS views
     FROM analytics_event
     WHERE event_type = 'screen_viewed'
       AND received_at >= $1 AND received_at < $2::timestamptz + interval '${RECEIVE_LAG}'
       AND occurred_at >= $1 AND occurred_at < $2
       AND payload->>'screen' IS NOT NULL
       AND ($3::text IS NULL OR platform::text = $3)
     GROUP BY 1
     ORDER BY players DESC, views DESC, screen
     LIMIT ${MAX_ROWS}`,
    from,
    to,
    platform,
  );
  return rows.map((raw) => screenRowSchema.parse(raw));
}
