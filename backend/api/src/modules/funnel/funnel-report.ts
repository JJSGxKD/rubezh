import type { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Воронка по источнику первого касания (docs/35-stage4-plan.md, Р30): сколько
 * аккаунтов дошло до каждой вехи, в разрезе площадки, вида и кода источника.
 * Когорта — по первому контакту с игрой: входу в канал или первому открытию
 * приложения, что раньше.
 *
 * Отчёт читает базу напрямую и потому живёт в командной строке, а не на
 * горячем пути: панель будет брать то же самое из витрины
 * (`22-analytics-and-metrics.md` §1, §4).
 */

export interface FunnelRow {
  platform: string;
  /** вид первого касания: `organic`, `click`, `invite`, … — `unknown`, если касания нет */
  startKind: string;
  /** код источника: клик, партнёр; `null` — без кода */
  startRef: string | null;
  accounts: number;
  entered: number;
  appOpened: number;
  firstRunStarted: number;
  firstRunFinished: number;
  runs2: number;
  runs5: number;
  returnedD1: number;
  returnedD7: number;
  firstPurchase: number;
}

/** Строк не больше этого — источников с тысячами кодов кликов в консоли всё равно не прочесть. */
const REPORT_LIMIT = 200;

interface RawRow {
  platform: string;
  start_kind: string;
  start_ref: string | null;
  accounts: bigint;
  entered: bigint;
  app_opened: bigint;
  first_run_started: bigint;
  first_run_finished: bigint;
  runs_2: bigint;
  runs_5: bigint;
  returned_d1: bigint;
  returned_d7: bigint;
  first_purchase: bigint;
}

export async function funnelReport(prisma: PrismaClient, from: Date, to: Date): Promise<FunnelRow[]> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT
      ac.platform::text AS platform,
      COALESCE(q.first_start_kind::text, 'unknown') AS start_kind,
      q.first_start_ref AS start_ref,
      count(*) AS accounts,
      count(f.entered_at) AS entered,
      count(f.app_opened_at) AS app_opened,
      count(f.first_run_started_at) AS first_run_started,
      count(f.first_run_finished_at) AS first_run_finished,
      count(f.runs_2_at) AS runs_2,
      count(f.runs_5_at) AS runs_5,
      count(f.returned_d1_at) AS returned_d1,
      count(f.returned_d7_at) AS returned_d7,
      count(f.first_purchase_at) AS first_purchase
    FROM account_funnel f
    JOIN account ac ON ac.account_id = f.account_id
    LEFT JOIN acquisition q ON q.account_id = f.account_id
    -- LEAST пропускает NULL: первый контакт — вход в канал или открытие, что было.
    WHERE LEAST(f.entered_at, f.app_opened_at) >= ${from}
      AND LEAST(f.entered_at, f.app_opened_at) < ${to}
    GROUP BY 1, 2, 3
    ORDER BY accounts DESC
    LIMIT ${REPORT_LIMIT}
  `;
  return rows.map((row) => ({
    platform: row.platform,
    startKind: row.start_kind,
    startRef: row.start_ref,
    accounts: Number(row.accounts),
    entered: Number(row.entered),
    appOpened: Number(row.app_opened),
    firstRunStarted: Number(row.first_run_started),
    firstRunFinished: Number(row.first_run_finished),
    runs2: Number(row.runs_2),
    runs5: Number(row.runs_5),
    returnedD1: Number(row.returned_d1),
    returnedD7: Number(row.returned_d7),
    firstPurchase: Number(row.first_purchase),
  }));
}
