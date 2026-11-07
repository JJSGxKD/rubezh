import { SubscriptionFetchError, SubscriptionFormatError, type SkipReason, type SkippedLink } from "@bh/proxy-kit";

/**
 * Тексты итога обновления подписки (`lastRefreshNote`, docs/35-stage4-plan.md
 * Р101). В них нет ни адреса подписки, ни куска ссылки узла, ни текста
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

/** «протокол: 2, транспорт: 1» — почему пропущены ссылки, по числу. */
function skippedBreakdown(skipped: readonly SkippedLink[]): string {
  return REASON_ORDER.flatMap((reason) => {
    const count = skipped.filter((link) => link.reason === reason).length;
    return count === 0 ? [] : [`${REASON_LABELS[reason]}: ${String(count)}`];
  }).join(", ");
}

/** «37 узлов, пропущено 3 (протокол: 2, транспорт: 1)». */
export function successNote(nodes: number, skipped: readonly SkippedLink[]): string {
  return clip(skipped.length === 0 ? nodesWord(nodes) : `${nodesWord(nodes)}, пропущено ${String(skipped.length)} (${skippedBreakdown(skipped)})`);
}

/**
 * «В подписке нет подходящих узлов: пропущено 12 (протокол: 9, параметры: 3)».
 * Причины и числа — чтобы по заметке было видно, что отсеяло подписку: заглушки
 * поставщика, формат или параметры узлов. Ни адреса, ни куска ссылки здесь нет.
 */
export function noNodesNote(skipped: readonly SkippedLink[]): string {
  const base = "В подписке нет подходящих узлов";
  return clip(skipped.length === 0 ? base : `${base}: пропущено ${String(skipped.length)} (${skippedBreakdown(skipped)})`);
}

/** Входов Xray не хватило на все узлы. */
export function overflowNote(count: number): string {
  const verb = count === 1 ? "не подключён" : "не подключены";
  return `Не хватило входов: ${nodesWord(count)} ${verb} — увеличьте XRAY_SLOT_COUNT`;
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
