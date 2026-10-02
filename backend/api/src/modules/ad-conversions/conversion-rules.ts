/**
 * Правила конверсий закупленной рекламы (docs/35-stage4-plan.md Р86, WP43):
 * окна, повторы и адрес постбэка — чистыми функциями, без базы и сети.
 */

/** Цели сети: 1 — регистрация, 2 — первая покупка, 3 — повторная (документация AdsGram, `goaltype`). */
export type ConversionGoal = 1 | 2 | 3;

/**
 * Окна (О39, **рабочие числа**):
 * - регистрация — первый засчитанный забег не позже 7 суток после клика: сеть
 *   учится на тех, кто играет, а не на открывших;
 * - покупки — 30 суток после клика;
 * - покупка уходит через 10 минут после оплаты, если её не вернули: продолжение
 *   уже законченного забега возвращается сразу, и такую оплату сети отдавать
 *   незачем;
 * - макросы сети живут на клике 31 сутки — дольше окна покупок с запасом на
 *   повторы отправки, потом обнуляются.
 */
export const CONVERSION_WINDOWS = {
  registrationDays: 7,
  purchaseDays: 30,
  purchaseSettleMin: 10,
  paramsKeepDays: 31,
  /** засчитанный забег — тот же порог, что у наград за забег */
  minRunSec: 30,
} as const;

/**
 * Паузы между попытками, минуты: сеть могла лечь на час, и конверсия должна
 * её пережить; после последней — «не отправлена» в журнале, повторить можно
 * руками.
 */
export const RETRY_DELAYS_MIN = [1, 5, 15, 60, 180, 360, 720, 1440] as const;

/** Без токена кабинета конверсия ждёт и проверяет его снова через столько минут. */
export const NO_TOKEN_RECHECK_MIN = 5;

/** Сколько конверсий отправляется за проход — проход раз в минуту. */
export const SEND_BATCH = 100;

export const POSTBACK_TIMEOUT_MS = 5_000;

/** Когда пробовать снова после `attempts` неудачных попыток; `null` — попытки кончились. */
export function retryAt(attempts: number, now: Date): Date | null {
  const delay = RETRY_DELAYS_MIN[attempts - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay * 60_000);
}

/** Что делать по ответу сети: 2xx — отправлено; отказ по сути — не повторять; сбой — повторить. */
export function verdictOf(status: number): "sent" | "rejected" | "retry" {
  if (status >= 200 && status < 300) return "sent";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "rejected";
}

export const ADSGRAM_POSTBACK = "https://api.adsgram.ai/confirm_conversion";

export interface PostbackInput {
  goal: ConversionGoal;
  /** макросы сети, сохранённые на клике */
  params: Readonly<Record<string, string>> | null;
  /** Telegram ID игрока; `null` — игрок не из Telegram */
  telegramId: string | null;
}

/**
 * Адрес постбэка AdsGram. Наша ссылка — веб, поэтому основной вариант —
 * `record` из `{record_data}`; кабинет, подставивший только `{campaign_id}`, —
 * вариант ссылок внутри Telegram: `tgid` и `campaignid`. Ни того, ни другого —
 * `null`: сеть не узнает, чья это конверсия.
 */
export function adsgramPostbackUrl(token: string, input: PostbackInput): URL | null {
  const url = new URL(ADSGRAM_POSTBACK);
  url.searchParams.set("token", token);
  const record = input.params?.record;
  const campaign = input.params?.campaign;
  if (record !== undefined) {
    url.searchParams.set("record", record);
  } else if (campaign !== undefined && input.telegramId !== null && /^\d{1,20}$/.test(input.telegramId)) {
    url.searchParams.set("tgid", input.telegramId);
    url.searchParams.set("campaignid", campaign);
  } else {
    return null;
  }
  url.searchParams.set("goaltype", String(input.goal));
  return url;
}

/** Адрес для лога: токен — не дальше процесса. */
export function redacted(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.set("token", "***");
  return copy.toString();
}
