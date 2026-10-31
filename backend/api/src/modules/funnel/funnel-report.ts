import type { PrismaClient } from "../../generated/prisma/client.js";
import { markedAccountIds } from "../restrictions/board-mark.js";

/**
 * Воронка по источнику первого касания (docs/35-stage4-plan.md, Р30): сколько
 * аккаунтов дошло до каждой вехи, в разрезе площадки, вида и источника.
 * Когорта — по первому контакту с игрой: входу в канал или первому открытию
 * приложения, что раньше.
 *
 * Источник — то, что сравнивают, а не то, что записано. У клика это кампания
 * ссылки (у прямой ссылки `l-<код>` — тоже, строка вида `click`: переходник и
 * прямая ссылка одной кампании сравниваются вместе): код клика свой у каждого перехода, и строка на клик превратила бы
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
      -- Прямая ссылка кампании (l-<код>, Р95) — то же, что клик по её переходнику: одна кампания, одна строка.
      CASE WHEN q.first_start_kind = 'link' THEN 'click' ELSE COALESCE(q.first_start_kind::text, 'unknown') END AS start_kind,
      CASE
        WHEN q.first_start_kind IN ('click', 'link') THEN l.campaign
        WHEN q.first_start_kind IN ('invite', 'friend') THEN NULL
        ELSE q.first_start_ref
      END AS start_ref,
      CASE WHEN q.first_start_kind IN ('click', 'link') THEN l.source END AS start_source,
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
    -- Клик — к своей ссылке и её кампании, прямая ссылка — к ссылке по коду; без ссылки (удалена) — кампания NULL.
    LEFT JOIN link_click lc ON q.first_start_kind = 'click' AND lc.click_id = q.first_start_ref
    LEFT JOIN link l ON l.code = CASE WHEN q.first_start_kind = 'link' THEN q.first_start_ref ELSE lc.link_code END
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

/** Сводная строка воронки: числа вех без разреза по источнику. */
export type FunnelMarked = Omit<FunnelRow, "platform" | "startKind" | "startRef" | "startSource">;

const NO_MARKED: FunnelMarked = { accounts: 0, entered: 0, appOpened: 0, firstRunStarted: 0, firstRunFinished: 0, runs2: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0 };

type RawMarked = Omit<RawRow, "platform" | "start_kind" | "start_ref" | "start_source">;

/**
 * Воронка по аккаунтам с видом «Отдельная доска» (T-0115): одна строка с теми
 * же вехами и той же когортой — первый контакт в окне, — что `funnelReport`.
 * Отчёт по источникам от метки не зависит: помеченные в нём считаются, как все.
 */
export async function funnelMarked(prisma: PrismaClient, from: Date, to: Date): Promise<FunnelMarked> {
  const ids = await markedAccountIds(prisma, from, to);
  if (ids.length === 0) return NO_MARKED;
  const [row] = await prisma.$queryRaw<RawMarked[]>`
    SELECT
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
    WHERE f.account_id = ANY(${ids}::uuid[])
      AND LEAST(f.entered_at, f.app_opened_at) >= ${from}
      AND LEAST(f.entered_at, f.app_opened_at) < ${to}
  `;
  if (row === undefined) return NO_MARKED;
  return {
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
  };
}

/** Строка воронки партнёра: площадка и источник привязки — ссылка или код — с вехами игроков, привязанных к нему. */
export interface PartnerFunnelRow extends FunnelMarked {
  platform: string;
  /** по чему привязан: ссылке партнёра или его промокоду; ссылка удалена — читается как «код» без названия */
  via: "link" | "code";
  /** кампания ссылки или название кампании промокода; `null` — её уже нет */
  viaName: string | null;
  /** код ссылки или id кампании промокода; `null` — её уже нет */
  viaRef: string | null;
}

type RawPartnerRow = RawMarked & { platform: string; via: string; via_name: string | null; via_ref: string | null };

/**
 * Воронка игроков партнёра (docs/35-stage4-plan.md, Р96, T-0068): те, кто привязан к нему
 * (`partner_binding`) по коду или ссылке; пришедший по его ссылке, но привязанный к другому
 * (слот был занят), — не его. Окно — по дате привязки (`bound_at`), а не по первому контакту: так
 * сравнивают то, как давно партнёр приводит игроков. Вехи — те же, что в `funnelReport`.
 *
 * Игрок без строки воронки всё равно считается: он привязан, а вехи у него нули.
 */
export async function partnerFunnelReport(prisma: PrismaClient, partnerId: string, from: Date, to: Date): Promise<PartnerFunnelRow[]> {
  const rows = await prisma.$queryRaw<RawPartnerRow[]>`
    SELECT
      ac.platform::text AS platform,
      CASE WHEN pb.link_code IS NOT NULL THEN 'link' ELSE 'code' END AS via,
      COALESCE(l.campaign, pc.title) AS via_name,
      COALESCE(pb.link_code, pb.campaign_id::text) AS via_ref,
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
    FROM partner_binding pb
    JOIN account ac ON ac.account_id = pb.account_id
    LEFT JOIN account_funnel f ON f.account_id = pb.account_id
    LEFT JOIN link l ON l.code = pb.link_code
    LEFT JOIN promo_campaign pc ON pc.campaign_id = pb.campaign_id
    WHERE pb.partner_id = ${partnerId}::uuid
      AND pb.bound_at >= ${from}
      AND pb.bound_at < ${to}
    GROUP BY 1, 2, 3, 4
    ORDER BY accounts DESC
    LIMIT ${REPORT_LIMIT}
  `;
  return rows.map((row) => ({
    platform: row.platform,
    via: row.via === "link" ? "link" : "code",
    viaName: row.via_name,
    viaRef: row.via_ref,
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

/** Воронка партнёра для панели: все игроки, источники привязки и площадки — одни вехи, три разреза. */
export interface PartnerFunnelView {
  total: FunnelMarked;
  sources: { via: "link" | "code"; name: string | null; ref: string | null; counts: FunnelMarked }[];
  platforms: { platform: string; counts: FunnelMarked }[];
}

const COUNT_KEYS = ["accounts", "entered", "appOpened", "firstRunStarted", "firstRunFinished", "runs2", "runs5", "returnedD1", "returnedD7", "firstPurchase"] as const;

function addCounts(target: FunnelMarked, row: FunnelMarked): void {
  for (const key of COUNT_KEYS) target[key] += row[key];
}

/**
 * Строки отчёта — в три разреза. Источник — ссылка или код, а не площадка: одна ссылка с двух площадок —
 * одна строка источника. Источники и площадки — по убыванию игроков, при равенстве по названию; без
 * названия (кампании больше нет) — после названных.
 */
export function partnerFunnelView(rows: readonly PartnerFunnelRow[]): PartnerFunnelView {
  const total: FunnelMarked = { ...NO_MARKED };
  const sources = new Map<string, PartnerFunnelView["sources"][number]>();
  const platforms = new Map<string, FunnelMarked>();
  for (const row of rows) {
    addCounts(total, row);
    const key = `${row.via}:${row.viaRef ?? row.viaName ?? ""}`;
    const source = sources.get(key) ?? { via: row.via, name: row.viaName, ref: row.viaRef, counts: { ...NO_MARKED } };
    addCounts(source.counts, row);
    sources.set(key, source);
    const platform = platforms.get(row.platform) ?? { ...NO_MARKED };
    addCounts(platform, row);
    platforms.set(row.platform, platform);
  }
  const byName = (left: string | null, right: string | null): number => (left === right ? 0 : left === null ? 1 : right === null ? -1 : left.localeCompare(right, "ru"));
  return {
    total,
    sources: [...sources.values()].sort((left, right) => right.counts.accounts - left.counts.accounts || byName(left.name, right.name)),
    platforms: [...platforms.entries()].map(([platform, counts]) => ({ platform, counts })).sort((left, right) => right.counts.accounts - left.counts.accounts || left.platform.localeCompare(right.platform)),
  };
}
