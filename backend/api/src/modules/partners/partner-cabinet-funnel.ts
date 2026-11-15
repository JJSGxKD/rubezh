import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { FunnelMarked } from "../funnel/funnel-report.js";

/**
 * Воронка в кабинете партнёра (docs/35-stage4-plan.md Р136, tasks/T-0219): что делают игроки, привязанные к
 * партнёру, — вход, первый забег, возвраты на 1-й и 7-й день, платящие, — по ссылкам, кодам, площадкам и дням.
 * Вехи те же, что в воронке команды (`funnel-report.ts`), и когорта та же: привязка (`partner_binding`) в окне.
 *
 * Приватность — ядро: в ответе нет ни ID, ни имён игроков, ни сумм покупок (только число платящих), а разрез,
 * где игроков меньше порога группы, **не уходит с сервера вовсе** — вместо чисел у него `counts: null`.
 * Порог применяет `buildCabinetFunnel`, а не панель: скрытое экраном видно в сетевом ответе.
 */

/** Вехи группы игроков: число привязанных и сколько дошло до каждой вехи. */
export type CabinetFunnelCounts = FunnelMarked;

/** Строка выборки: ссылка или код, площадка — вехи числами. Откуда взяты числа, строка не хранит: игроков в ней нет. */
export interface CabinetFunnelSourceRow {
  /** по чему привязаны: ссылке партнёра или его промокоду; ссылка удалена — читается как «код» без названия */
  via: "link" | "code";
  /** код ссылки или id кампании промокода; `null` — её уже нет */
  ref: string | null;
  /** кампания ссылки или слово кода (без названия кампании для команды); `null` — её уже нет */
  name: string | null;
  /** что за ссылка — `channel`, `post`…; у кода и у ссылки без источника — `null` */
  source: string | null;
  note: string | null;
  platform: string;
  counts: CabinetFunnelCounts;
}

export interface CabinetFunnelDayRow {
  /** московские сутки привязки, `2026-10-10` — как у остальных суточных отчётов панели */
  day: string;
  counts: CabinetFunnelCounts;
}

/** Всё, что отчёт берёт из базы; порог и разрезы собирает `buildCabinetFunnel`. */
export interface CabinetFunnelRaw {
  /** переходы по ссылкам партнёра за период: счётчик ссылок, а не игроков */
  clicks: number;
  sources: CabinetFunnelSourceRow[];
  days: CabinetFunnelDayRow[];
}

export const CABINET_FUNNEL = Symbol("CABINET_FUNNEL");

/** Отдельным портом, как `PartnerFunnelSource` карточки: тесты кабинета без базы подставляют память. */
export interface CabinetFunnelSource {
  /** Игроки, привязанные к партнёру в окне `[from, to)` по дате привязки, и клики его ссылок в том же окне. */
  report(partnerId: string, from: Date, to: Date): Promise<CabinetFunnelRaw>;
}

/** Срез ссылки или кода; `counts: null` — игроков меньше порога, чисел нет. */
export interface CabinetFunnelSlice {
  via: "link" | "code";
  ref: string | null;
  name: string | null;
  source: string | null;
  note: string | null;
  counts: CabinetFunnelCounts | null;
}

export interface CabinetFunnel {
  from: string;
  to: string;
  /** порог группы из настроек: панель называет его в строках «меньше N игроков» */
  minGroup: number;
  clicks: number;
  /** игроков в итоге меньше порога: чисел нет нигде, кроме переходов */
  tooFew: boolean;
  total: CabinetFunnelCounts | null;
  sources: CabinetFunnelSlice[];
  platforms: { platform: string; counts: CabinetFunnelCounts | null }[];
  /** по убыванию даты; только дни с игроками не меньше порога */
  days: CabinetFunnelDayRow[];
  /** сколько дней скрыто: числа игроков за ними не уходят, только то, что такие дни были */
  hiddenDays: number;
}

const COUNT_KEYS = ["accounts", "entered", "appOpened", "firstRunStarted", "firstRunFinished", "runs2", "runs5", "returnedD1", "returnedD7", "firstPurchase"] as const;

function empty(): CabinetFunnelCounts {
  return { accounts: 0, entered: 0, appOpened: 0, firstRunStarted: 0, firstRunFinished: 0, runs2: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0 };
}

function add(target: CabinetFunnelCounts, row: CabinetFunnelCounts): void {
  for (const key of COUNT_KEYS) target[key] += row[key];
}

const byName = (left: string | null, right: string | null): number => (left === right ? 0 : left === null ? 1 : right === null ? -1 : left.localeCompare(right, "ru"));

/** Видимые — по убыванию игроков, при равенстве по названию; скрытые — после них и по названию: порядок не выдаёт их размер. */
function arrange<T>(items: readonly T[], counts: (item: T) => CabinetFunnelCounts | null, name: (item: T) => string | null): T[] {
  const visible = items.filter((item) => counts(item) !== null);
  const hidden = items.filter((item) => counts(item) === null);
  visible.sort((left, right) => (counts(right)?.accounts ?? 0) - (counts(left)?.accounts ?? 0) || byName(name(left), name(right)));
  hidden.sort((left, right) => byName(name(left), name(right)));
  return [...visible, ...hidden];
}

/**
 * Выборка — в ответ кабинета с порогом группы. Итог меньше порога — «только строка о пороге»: ни итога, ни
 * разрезов, ни дней (каждый из них не больше итога, а значит, меньше порога сам). Иначе каждый разрез — ссылка
 * или код, площадка, день — показывается числами, если игроков в нём не меньше порога, и без них, если меньше.
 * Источник — ссылка или код, а не площадка: одна ссылка с двух площадок — один разрез.
 */
export function buildCabinetFunnel(raw: CabinetFunnelRaw, period: { from: Date; to: Date }, minGroup: number): CabinetFunnel {
  const base = { from: period.from.toISOString(), to: period.to.toISOString(), minGroup, clicks: raw.clicks };
  const total = empty();
  const sources = new Map<string, CabinetFunnelSourceRow & { sum: CabinetFunnelCounts }>();
  const platforms = new Map<string, CabinetFunnelCounts>();
  for (const row of raw.sources) {
    add(total, row.counts);
    const key = `${row.via}:${row.ref ?? row.name ?? ""}`;
    const source = sources.get(key) ?? { ...row, sum: empty() };
    add(source.sum, row.counts);
    sources.set(key, source);
    const platform = platforms.get(row.platform) ?? empty();
    add(platform, row.counts);
    platforms.set(row.platform, platform);
  }
  if (total.accounts < minGroup) return { ...base, tooFew: true, total: null, sources: [], platforms: [], days: [], hiddenDays: 0 };

  const shown = (counts: CabinetFunnelCounts): CabinetFunnelCounts | null => (counts.accounts >= minGroup ? counts : null);
  const days = new Map<string, CabinetFunnelCounts>();
  for (const row of raw.days) {
    const day = days.get(row.day) ?? empty();
    add(day, row.counts);
    days.set(row.day, day);
  }
  const dayRows = [...days.entries()].map(([day, counts]) => ({ day, counts }));
  const visibleDays = dayRows.filter((row) => row.counts.accounts >= minGroup).sort((left, right) => right.day.localeCompare(left.day));

  return {
    ...base,
    tooFew: false,
    total,
    sources: arrange(
      [...sources.values()].map(({ sum, via, ref, name, source, note }): CabinetFunnelSlice => ({ via, ref, name, source, note, counts: shown(sum) })),
      (slice) => slice.counts,
      (slice) => slice.name,
    ),
    platforms: arrange(
      [...platforms.entries()].map(([platform, counts]) => ({ platform, counts: shown(counts) })),
      (slice) => slice.counts,
      (slice) => slice.platform,
    ),
    days: visibleDays,
    hiddenDays: dayRows.length - visibleDays.length,
  };
}

const FUNNEL_MAX_DAYS = 366;
const DAY_MS = 86_400_000;

/** Период отчёта — как у остальных отчётов панели: начало раньше конца, не длиннее года. */
export function checkFunnelPeriod(period: { from: Date; to: Date }): void {
  if (Number.isNaN(period.from.getTime()) || Number.isNaN(period.to.getTime())) throw new ValidationError("Некорректные даты периода");
  if (!(period.from < period.to)) throw new ValidationError("Начало периода должно быть раньше конца");
  if (period.to.getTime() - period.from.getTime() > FUNNEL_MAX_DAYS * DAY_MS) throw new ValidationError("Период не длиннее года");
}

/** Разрезов «ссылка или код × площадка» у партнёра десятки; предел страхует от мусора. */
const SOURCES_LIMIT = 500;
/** Суток в годовом окне не больше 367 по московской границе. */
const DAYS_LIMIT = 400;

interface RawCounts {
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

function countsOf(row: RawCounts): CabinetFunnelCounts {
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

type RawSourceRow = RawCounts & { platform: string; via: string; ref: string | null; name: string | null; source: string | null; note: string | null };
type RawDayRow = RawCounts & { day: string };

@Injectable()
export class PrismaCabinetFunnel implements CabinetFunnelSource {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async report(partnerId: string, from: Date, to: Date): Promise<CabinetFunnelRaw> {
    const [sources, days, clicks] = await Promise.all([this.sources(partnerId, from, to), this.days(partnerId, from, to), this.clicks(partnerId, from, to)]);
    return { clicks, sources, days };
  }

  /**
   * Игроки по ссылке или коду и площадке. Игрок без строки воронки всё равно считается: он привязан, а вехи у него
   * нули. Слово кода — первый код кампании: названия кампаний команда придумывает для себя, партнёру они не уходят.
   */
  private async sources(partnerId: string, from: Date, to: Date): Promise<CabinetFunnelSourceRow[]> {
    const rows = await this.prisma.$queryRaw<RawSourceRow[]>`
      SELECT
        ac.platform::text AS platform,
        CASE WHEN pb.link_code IS NOT NULL THEN 'link' ELSE 'code' END AS via,
        COALESCE(pb.link_code, pb.campaign_id::text) AS ref,
        CASE WHEN pb.link_code IS NOT NULL THEN l.campaign ELSE pcode.display END AS name,
        l.source AS source,
        l.note AS note,
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
      LEFT JOIN LATERAL (SELECT pc.display FROM promo_code pc WHERE pc.campaign_id = pb.campaign_id ORDER BY pc.code LIMIT 1) pcode ON true
      WHERE pb.partner_id = ${partnerId}::uuid
        AND pb.bound_at >= ${from}
        AND pb.bound_at < ${to}
      GROUP BY ac.platform, pb.link_code, pb.campaign_id, l.campaign, l.source, l.note, pcode.display
      ORDER BY accounts DESC
      LIMIT ${SOURCES_LIMIT}
    `;
    return rows.map((row) => ({ via: row.via === "link" ? "link" : "code", ref: row.ref, name: row.name, source: row.source, note: row.note, platform: row.platform, counts: countsOf(row) }));
  }

  /** Сутки привязки по Москве — граница, одна на все суточные отчёты панели. */
  private async days(partnerId: string, from: Date, to: Date): Promise<CabinetFunnelDayRow[]> {
    const rows = await this.prisma.$queryRaw<RawDayRow[]>`
      SELECT
        to_char((pb.bound_at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, 'YYYY-MM-DD') AS day,
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
      LEFT JOIN account_funnel f ON f.account_id = pb.account_id
      WHERE pb.partner_id = ${partnerId}::uuid
        AND pb.bound_at >= ${from}
        AND pb.bound_at < ${to}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${DAYS_LIMIT}
    `;
    return rows.map((row) => ({ day: row.day, counts: countsOf(row) }));
  }

  /** Клики по всем ссылкам партнёра — и заведённым им, и заведённым командой от его имени. */
  private async clicks(partnerId: string, from: Date, to: Date): Promise<number> {
    return await this.prisma.linkClick.count({ where: { at: { gte: from, lt: to }, link: { partnerId } } });
  }
}
