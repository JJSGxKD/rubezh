import type { DonationView } from "../../state/donations-api";

/**
 * Правила доната без React (docs/35-stage4-plan.md, Р109, T-0158): какая сумма
 * годится и какие способы поддержать видны игроку. Пределы и список готовых
 * сумм приходят с сервера — клиент их не придумывает.
 */

/** Больше знаков в сумме быть не может: дальше число перестаёт быть точным. */
const MAX_DIGITS = 15;

export type ParsedAmount = { ok: true; amount: number } | { ok: false };

/**
 * Своя сумма — целое число цифрами от `min` до `max`. Пробелы по краям, знак,
 * дробная часть, ведущие нули и пустая строка — не сумма: молча «поправить»
 * ввод значило бы выставить счёт на сумму, которую игрок не набирал.
 */
export function parseAmount(text: string, min: number, max: number): ParsedAmount {
  if (!/^[1-9]\d*$/.test(text) || text.length > MAX_DIGITS) return { ok: false };
  const amount = Number(text);
  return amount >= min && amount <= max ? { ok: true, amount } : { ok: false };
}

/** Какая готовая сумма выбрана первой: вторая, если она есть, иначе первая; готовых нет — ничего. */
export function defaultAmount(presets: readonly number[]): number | null {
  return presets[1] ?? presets[0] ?? null;
}

export interface VisibleWays {
  /** звёзды: кнопка «Поддержать» и лист сумм */
  stars: boolean;
  /** ссылка Tribute и её разрез для аналитики; `null` — кнопки нет */
  tribute: { url: string; way: string } | null;
}

/** Ссылка — только `https`: клиент не открывает `javascript:` и `http:` ни от кого, и серверу тоже. */
function isHttps(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === "https:";
}

/**
 * Что из способов видно. Звёзды — когда сервер дал сумму (`stars !== null`):
 * выключенная оплата, площадка без способа и закрытые покупки приходят одним
 * `null`, и мёртвой кнопки не бывает. Tribute — только при `https`-ссылке.
 */
export function visibleWays(view: Pick<DonationView, "stars" | "tribute">): VisibleWays {
  const tribute = view.tribute ?? null;
  return {
    stars: view.stars !== null,
    tribute: tribute !== null && isHttps(tribute.url) ? { url: tribute.url, way: tribute.way } : null,
  };
}

/** Есть хоть один способ — блок «Поддержать проект» рисуется только тогда. */
export function hasAnyWay(view: Pick<DonationView, "stars" | "tribute">): boolean {
  const ways = visibleWays(view);
  return ways.stars || ways.tribute !== null;
}
