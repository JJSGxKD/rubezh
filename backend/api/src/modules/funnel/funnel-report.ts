import type { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Воронка по источнику первого касания (docs/35-stage4-plan.md, Р30): сколько
 * аккаунтов дошло до каждой вехи, в разрезе площадки, вида и источника.
 * Когорта — по первому контакту с игрой: входу в канал или первому открытию
 * приложения, что раньше.
 *
 * Источник — то, что сравнивают, а не то, что записано. У клика это кампания
 * ссылки: код клика свой у каждого перехода, и строка на клик превратила бы
 * отчёт в тысячи строк по одному аккаунту. Приглашения — одной строкой на
 * вид: код у каждого пригласившего свой, а сравнивают канал «друзья», не
 * людей. Остальные коды — уведомления бота, партнёрка Telegram — немногие и
 * остаются как есть.
 *
 * Отчёт читает базу напрямую и потому живёт в командной строке, а не на
 * горячем пути: панель будет брать то же самое из витрины
 * (`22-analytics-and-metrics.md` §1, §4).
 */

export interface FunnelRow {
  platform: string;
  /** вид первого касания: `organic`, `click`, `invite`, … — `unknown`, если касания нет */
  startKind: string;
  /** источник внутри вида: кампания ссылки у клика, вид уведомления; `null` — без него */
  startRef: string | null;
  /** источник кампании ссылки (`tg_ads`) у клика; `null` — у остальных и у кампании без источника */
  startSource: string | null;
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

/** Строк не больше этого: кампаний и видов уведомлений — десятки, предел страхует от мусора в кодах. */
const REPORT_LIMIT = 200;

interface RawRow {
  platform: string;
  start_kind: string;
  start_ref: string | null;
  start_source: string | null;
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
      CASE
        WHEN q.first_start_kind = 'click' THEN l.campaign
        WHEN q.first_start_kind IN ('invite', 'friend') THEN NULL
        ELSE q.first_start_ref
      END AS start_ref,
      CASE WHEN q.first_start_kind = 'click' THEN l.source END AS start_source,
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
    -- Клик — к своей ссылке и её кампании; клик без ссылки (удалена) — кампания NULL.
    LEFT JOIN link_click lc ON q.first_start_kind = 'click' AND lc.click_id = q.first_start_ref
    LEFT JOIN link l ON l.code = lc.link_code
    -- LEAST пропускает NULL: первый контакт — вход в канал или открытие, что было.
    WHERE LEAST(f.entered_at, f.app_opened_at) >= ${from}
      AND LEAST(f.entered_at, f.app_opened_at) < ${to}
    GROUP BY 1, 2, 3, 4
    ORDER BY accounts DESC
    LIMIT ${REPORT_LIMIT}
  `;
  return rows.map((row) => ({
    platform: row.platform,
    startKind: row.start_kind,
    startRef: row.start_ref,
    startSource: row.start_source,
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
