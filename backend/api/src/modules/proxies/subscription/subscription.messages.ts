import { SubscriptionFetchError, SubscriptionFormatError, type SkipReason, type SkippedLink } from "@bh/proxy-kit";

/**
 * Тексты итога обновления подписки (`lastRefreshNote`, docs/35-stage4-plan.md
 * Р101, Р192). В них нет ни адреса подписки, ни куска ссылки узла, ни текста
 * исключения: адрес секретный целиком, а исключение сети его цитирует.
 */

/** Заметка в колонке — 300 знаков. */
const NOTE_MAX = 300;

export const NOTES = {
  notAllowed: "Адрес подписки не подходит: нужен публичный https-адрес",
  timeout: "Поставщик не ответил за 15 секунд",
  tooLarge: "Ответ поставщика больше 2 МБ",
  network: "Не удалось связаться с поставщиком",
  tooManyRedirects: "Поставщик перенаправил запрос слишком много раз",
  unsupportedFormat: "Формат подписки не поддерживается: нужен список ссылок (base64 или текст) или JSON-конфиг Xray",
  empty: "Подписка пустая",
  noSidecar: "Контейнер Xray не подключён: конфиг некуда записать",
  writeFailed: "Не удалось записать конфиг Xray",
  noCipher: "Адрес подписки нельзя прочитать: на сервере нет ключа шифрования",
  unreadable: "Адрес подписки не читается: он зашифрован другим ключом — задайте адрес заново",
} as const;

const clip = (text: string): string => (text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text);

/** Форма слова по числу: один, два, пять. */
export function plural(count: number, one: string, few: string, many: string): string {
  const tail = Math.abs(count) % 100;
  const last = tail % 10;
  if (tail > 10 && tail < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const nodesWord = (count: number): string => `${String(count)} ${plural(count, "узел", "узла", "узлов")}`;

const REASON_LABELS: Record<SkipReason, string> = {
  unsupported_scheme: "протокол",
  unsupported_transport: "транспорт",
  unsupported_option: "параметры",
  unsupported_cipher: "шифр",
  malformed: "ссылка",
};
const REASON_ORDER: readonly SkipReason[] = ["unsupported_scheme", "unsupported_transport", "unsupported_option", "unsupported_cipher", "malformed"];

/** Имя параметра, схемы или транспорта — только оно попадает в заметку; всё прочее (кусок ссылки, адрес) — нет. */
const NAME_FORMAT = /^[A-Za-z0-9._+-]{1,32}$/;
const OTHER_NAME = "прочее";
/** Сколько имён называется на причину: самые частые, остальные только в числе пропущенных. */
const NAMES_PER_REASON = 3;

/**
 * «протокол: hysteria2 2; параметры: allowInsecure 2, dialerProxy 1» — почему пропущены
 * ссылки: причина, имена и сколько раз. `detail` по контракту `proxy-kit` — имя параметра,
 * но заметка не верит ему на слово: что на имя не похоже, сворачивается в «прочее».
 */
function skippedBreakdown(skipped: readonly SkippedLink[]): string {
  const byReason = new Map<SkipReason, Map<string, number>>();
  for (const link of skipped) {
    const names = byReason.get(link.reason) ?? new Map<string, number>();
    const name = NAME_FORMAT.test(link.detail) ? link.detail : OTHER_NAME;
    names.set(name, (names.get(name) ?? 0) + 1);
    byReason.set(link.reason, names);
  }
  const total = (names: ReadonlyMap<string, number>): number => [...names.values()].reduce((sum, count) => sum + count, 0);
  // Частые причины первыми, при равенстве — в порядке словаря.
  const reasons = REASON_ORDER.filter((reason) => byReason.has(reason)).sort((a, b) => total(byReason.get(b) ?? new Map()) - total(byReason.get(a) ?? new Map()));
  return reasons.flatMap((reason) => {
    const names = byReason.get(reason);
    if (names === undefined) return [];
    const top = [...names].sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0)).slice(0, NAMES_PER_REASON);
    return [`${REASON_LABELS[reason]}: ${top.map(([name, count]) => `${name} ${String(count)}`).join(", ")}`];
  }).join("; ");
}

/** «37 узлов, пропущено 4 — параметры: allowInsecure 2, dialerProxy 1; транспорт: kcp 1». */
export function successNote(nodes: number, skipped: readonly SkippedLink[]): string {
  return clip(skipped.length === 0 ? nodesWord(nodes) : `${nodesWord(nodes)}, пропущено ${String(skipped.length)} — ${skippedBreakdown(skipped)}`);
}

/**
 * «В подписке нет подходящих узлов: пропущено 12 — протокол: hysteria2 9; параметры: allowInsecure 3».
 * Причины, имена и числа — чтобы по заметке было видно, что отсеяло подписку: заглушки
 * поставщика, формат или параметры узлов. Ни адреса, ни куска ссылки здесь нет.
 */
export function noNodesNote(skipped: readonly SkippedLink[]): string {
  const base = "В подписке нет подходящих узлов";
  return clip(skipped.length === 0 ? base : `${base}: пропущено ${String(skipped.length)} — ${skippedBreakdown(skipped)}`);
}

/** Входов Xray не хватило на все узлы: на подписку приходится `quota` входов (поровну между подписками). */
export function overflowNote(count: number, quota: number): string {
  const verb = count === 1 ? "не подключён" : "не подключены";
  return `Не хватило входов: ${nodesWord(count)} ${verb} — на подписку приходится ${String(quota)} ${plural(quota, "вход", "входа", "входов")}; увеличьте XRAY_SLOT_COUNT или удалите лишние подписки`;
}

export const joinNotes = (...parts: string[]): string => clip(parts.join(". "));

export function fetchErrorNote(error: SubscriptionFetchError): string {
  switch (error.code) {
    case "blocked_url":
      return NOTES.notAllowed;
    case "http_status":
      return `Поставщик ответил кодом ${String(error.status ?? 0)}`;
    case "timeout":
      return NOTES.timeout;
    case "too_large":
      return NOTES.tooLarge;
    case "too_many_redirects":
      return NOTES.tooManyRedirects;
    case "network":
      return NOTES.network;
  }
}

export function formatErrorNote(error: SubscriptionFormatError): string {
  return error.code === "empty" ? NOTES.empty : NOTES.unsupportedFormat;
}
