import { z } from "zod";
import { FLAG_PLATFORMS } from "./flags";
import type { AdminApi, ApiResult } from "./client";
import type { Period } from "./funnel";
import { formatNumber } from "../format";

/**
 * Доля флага против остальных (`GET /admin/funnel/flag-split`,
 * docs/35-stage4-plan.md WP12, часть 10b): по нему решают, оставить ли
 * выкаченное, — межстраничную прежде всего. Когорта — впервые открывшие
 * приложение за период на площадках флага; доля — та же корзина, что у
 * флага.
 *
 * Разница сама по себе ничего не значит: на сотне игроков проценты
 * прыгают случайно. Поэтому у каждой строки — вывод: надёжна ли разница,
 * не отличить ли её от случайности, или данных пока мало.
 */

const momentSchema = z.object({ sum: z.number(), sumSq: z.number() });

const groupSchema = z.object({
  players: z.number(),
  d1Eligible: z.number(),
  d1Returned: z.number(),
  d7Eligible: z.number(),
  d7Returned: z.number(),
  payers: z.number(),
  /** `null` — нет права на доход */
  stars: momentSchema.nullable(),
  runs: momentSchema,
  interstitials: momentSchema,
  rewarded: momentSchema,
});

const flagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  platforms: z.array(z.enum(FLAG_PLATFORMS)),
  percent: z.number(),
  note: z.string().nullable(),
  updatedAt: z.string(),
});

export const flagSplitSchema = z.object({
  flags: z.array(flagSchema),
  /** выбранный флаг; `null` — флагов нет */
  flag: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  split: z.object({ share: groupSchema, rest: groupSchema }).nullable(),
});

export type FlagSplitResponse = z.infer<typeof flagSplitSchema>;
export type SplitGroup = z.infer<typeof groupSchema>;
export type SplitMoment = z.infer<typeof momentSchema>;
export type SplitFlag = z.infer<typeof flagSchema>;

export function fetchFlagSplit(api: AdminApi, flag: string | null, period: Period): Promise<ApiResult<FlagSplitResponse>> {
  return api.request("/funnel/flag-split", { query: { flag: flag ?? undefined, from: period.from, to: period.to }, schema: flagSplitSchema });
}

/** Φ(z) нормального распределения; erf — по Абрамовицу и Стигану (7.1.26), погрешность меньше 1,5·10⁻⁷. */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function twoSided(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Насколько вероятна такая разница долей, если на самом деле её нет
 * (z-критерий для двух долей). `null` — сравнивать не с чем.
 */
export function proportionP(x1: number, n1: number, x2: number, n2: number): number | null {
  if (n1 === 0 || n2 === 0) return null;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  // У обеих долей 0% или 100% — разницы нет вовсе.
  if (se === 0) return 1;
  return twoSided((x1 / n1 - x2 / n2) / se);
}

/**
 * То же для средних (критерий Уэлча; при наших числах игроков t почти
 * нормально). Среднее с длинным хвостом — звёзды — один кит сдвигает
 * сильно, поэтому рядом с ним — доля платящих.
 */
export function meanP(a: SplitMoment, n1: number, b: SplitMoment, n2: number): number | null {
  if (n1 < 2 || n2 < 2) return null;
  const m1 = a.sum / n1;
  const m2 = b.sum / n2;
  const v1 = Math.max(0, (a.sumSq - n1 * m1 * m1) / (n1 - 1));
  const v2 = Math.max(0, (b.sumSq - n2 * m2 * m2) / (n2 - 1));
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return m1 === m2 ? 1 : 0;
  return twoSided((m1 - m2) / se);
}

/** Меньше стольких игроков в любой из долей — вывода нет: десяток игроков случай качает на десятки процентов. */
export const MIN_GROUP = 30;
/** Порог надёжности — вероятность увидеть такую разницу случайно. */
export const RELIABLE_P = 0.05;

export type SplitVerdict = "reliable" | "noise" | "few";

export const VERDICT_TITLES: Record<SplitVerdict, string> = {
  reliable: "разница надёжна",
  noise: "не отличить от случайности",
  few: "мало данных",
};

export function verdictOf(p: number | null, n1: number, n2: number): SplitVerdict {
  if (p === null || Math.min(n1, n2) < MIN_GROUP) return "few";
  return p < RELIABLE_P ? "reliable" : "noise";
}

/** Строка сравнения: значение в доле и у остальных, разница и вывод. */
export interface SplitMetric {
  key: string;
  title: string;
  /** что значит показатель — подсказка в строке */
  hint: string;
  share: { value: string; detail: string | null };
  rest: { value: string; detail: string | null };
  /** `null` — разницы нет смысла считать */
  diff: string | null;
  verdict: SplitVerdict | null;
}

const percent = (value: number): string => `${(value * 100).toFixed(1).replace(".", ",")}%`;
const decimal = (value: number): string => (Math.round(value * 100) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
const signed = (text: string, value: number): string => (value > 0 ? `+${text}` : value < 0 ? `−${text}` : text);

function rate(key: string, title: string, hint: string, share: { x: number; n: number }, rest: { x: number; n: number }, waiting: string): SplitMetric {
  const cell = (part: { x: number; n: number }) => (part.n === 0 ? { value: "—", detail: waiting } : { value: percent(part.x / part.n), detail: `${formatNumber(part.x)} из ${formatNumber(part.n)}` });
  const ready = share.n > 0 && rest.n > 0;
  const delta = ready ? share.x / share.n - rest.x / rest.n : 0;
  return {
    key,
    title,
    hint,
    share: cell(share),
    rest: cell(rest),
    diff: ready ? signed(`${(Math.abs(delta) * 100).toFixed(1).replace(".", ",")} п.п.`, delta) : null,
    verdict: verdictOf(proportionP(share.x, share.n, rest.x, rest.n), share.n, rest.n),
  };
}

function mean(key: string, title: string, hint: string, share: { m: SplitMoment; n: number }, rest: { m: SplitMoment; n: number }, unit: string): SplitMetric {
  const avg = (part: { m: SplitMoment; n: number }) => (part.n === 0 ? null : part.m.sum / part.n);
  const cell = (part: { m: SplitMoment; n: number }) => {
    const value = avg(part);
    return value === null ? { value: "—", detail: null } : { value: decimal(value), detail: `всего ${formatNumber(part.m.sum)} ${unit}` };
  };
  const a = avg(share);
  const b = avg(rest);
  let diff: string | null = null;
  if (a !== null && b !== null) {
    const delta = a - b;
    const relative = b === 0 ? "" : ` (${signed(`${Math.round((Math.abs(delta) / b) * 100)}%`, delta)})`;
    diff = `${signed(decimal(Math.abs(delta)), delta)}${relative}`;
  }
  return { key, title, hint, share: cell(share), rest: cell(rest), diff, verdict: verdictOf(meanP(share.m, share.n, rest.m, rest.n), share.n, rest.n) };
}

/**
 * Строки сравнения в порядке решения: сколько игроков, удержание, деньги,
 * вовлечённость, реклама. Звёзды — только когда сервер их отдал.
 */
export function splitMetrics(share: SplitGroup, rest: SplitGroup): SplitMetric[] {
  const total = share.players + rest.players;
  const rows: SplitMetric[] = [
    {
      key: "players",
      title: "Игроков",
      hint: "Впервые открыли игру за период на площадках флага. Доля — от всех: должна быть близка к доле флага.",
      share: { value: formatNumber(share.players), detail: total === 0 ? null : `${percent(share.players / total)} от всех` },
      rest: { value: formatNumber(rest.players), detail: total === 0 ? null : `${percent(rest.players / total)} от всех` },
      diff: null,
      verdict: null,
    },
    rate(
      "d1",
      "Вернулись на 1-й день",
      "Открыли игру на следующие московские сутки после первого входа или позже. Считаются только пришедшие до вчерашнего дня — остальные вернуться ещё не могли.",
      { x: share.d1Returned, n: share.d1Eligible },
      { x: rest.d1Returned, n: rest.d1Eligible },
      "никто ещё не мог вернуться",
    ),
    rate(
      "d7",
      "Вернулись на 7-й день",
      "Открыли игру на седьмые сутки после первого входа или позже. Считаются только пришедшие семь и больше дней назад.",
      { x: share.d7Returned, n: share.d7Eligible },
      { x: rest.d7Returned, n: rest.d7Eligible },
      "рано: нужна неделя",
    ),
    rate(
      "payers",
      "Платящих",
      "Сделали хотя бы одну настоящую покупку звёздами; тестовые оплаты не в счёт.",
      { x: share.payers, n: share.players },
      { x: rest.payers, n: rest.players },
      "нет игроков",
    ),
  ];
  if (share.stars !== null && rest.stars !== null) {
    rows.push(
      mean(
        "stars",
        "Звёзд на игрока",
        "Списано звёзд за настоящие покупки без возвратов, в среднем на игрока. Один крупный покупатель сдвигает среднее — смотрите и на долю платящих.",
        { m: share.stars, n: share.players },
        { m: rest.stars, n: rest.players },
        "⭐",
      ),
    );
  }
  rows.push(
    mean("runs", "Забегов на игрока", "Законченных забегов в среднем. Падение — знак, что что-то мешает играть.", { m: share.runs, n: share.players }, { m: rest.runs, n: rest.players }, "забегов"),
    mean(
      "interstitials",
      "Межстраничных на игрока",
      "Межстраничных на экране в среднем. Для флага межстраничной это её доход: у доли показы есть, у остальных — нет.",
      { m: share.interstitials, n: share.players },
      { m: rest.interstitials, n: rest.players },
      "показов",
    ),
    mean(
      "rewarded",
      "Роликов за награду на игрока",
      "Досмотренных роликов за награду в среднем — колесо, удвоение, второй шанс. Падение — межстраничная отнимает показы за награду.",
      { m: share.rewarded, n: share.players },
      { m: rest.rewarded, n: rest.players },
      "роликов",
    ),
  );
  return rows;
}
