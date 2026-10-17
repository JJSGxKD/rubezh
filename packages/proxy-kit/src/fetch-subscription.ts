import { checkSubscriptionUrl } from "./url-guard.js";
import { parseUpdateIntervalHours, parseUserInfo, type UserInfo } from "./subscription.js";

export interface FetchSubscriptionOptions {
  fetch: typeof fetch;
  /** бросает, если нельзя ходить на этот адрес; зовётся для адреса и для каждого `Location` */
  assertAllowed: (url: URL) => Promise<void>;
  userAgent?: string;
  timeoutMs?: number;
  /** считается по потоку, а не по заголовку */
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export type FetchErrorCode = "blocked_url" | "http_status" | "too_large" | "timeout" | "network" | "too_many_redirects";

/** Тексты без адреса, токена и причины из сети: адрес подписки секретный целиком. */
const MESSAGES: Record<FetchErrorCode, string> = {
  blocked_url: "Адрес подписки не разрешён",
  http_status: "Сервер подписки ответил ошибкой",
  too_large: "Подписка слишком большая",
  timeout: "Сервер подписки не ответил вовремя",
  network: "Сервер подписки недоступен",
  too_many_redirects: "Слишком много переходов при загрузке подписки",
};

export class SubscriptionFetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status: number | null;

  constructor(code: FetchErrorCode, status: number | null = null) {
    super(MESSAGES[code]);
    this.name = "SubscriptionFetchError";
    this.code = code;
    this.status = status;
  }
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface FetchedSubscription {
  body: string;
  userInfo: UserInfo | null;
  updateIntervalHours: number | null;
}

/**
 * Скачать подписку. Сеть и проверка адреса приходят аргументами: пакет сам в
 * сеть и DNS не ходит. Переходы идут вручную (`redirect: "manual"`) — каждый
 * `Location` проверяется заново, иначе открытый адрес перенаправил бы запрос
 * на закрытый.
 */
export async function fetchSubscription(url: string, options: FetchSubscriptionOptions): Promise<FetchedSubscription> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  if (options.signal?.aborted === true) controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  // Зависший `fetch` может не слушать сигнал: ожидание обрывается гонкой.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new SubscriptionFetchError(timedOut ? "timeout" : "network")), { once: true });
  });
  aborted.catch(() => undefined);
  const guarded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);

  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const checked = checkSubscriptionUrl(current);
      if (!checked.ok) throw new SubscriptionFetchError("blocked_url");
      try {
        await guarded(options.assertAllowed(checked.url));
      } catch (error) {
        if (error instanceof SubscriptionFetchError) throw error;
        throw new SubscriptionFetchError("blocked_url");
      }

      let response: Response;
      try {
        response = await guarded(
          options.fetch(checked.url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { "user-agent": options.userAgent ?? "v2rayN/7.0", accept: "*/*" },
          }),
        );
      } catch (error) {
        if (error instanceof SubscriptionFetchError) throw error;
        throw new SubscriptionFetchError(timedOut ? "timeout" : "network");
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (location === null || location === "") throw new SubscriptionFetchError("http_status", response.status);
        if (hop >= maxRedirects) throw new SubscriptionFetchError("too_many_redirects");
        try {
          current = new URL(location, checked.url).href;
        } catch {
          throw new SubscriptionFetchError("http_status", response.status);
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new SubscriptionFetchError("http_status", response.status);
      }

      const body = await readLimited(response, maxBytes, guarded);
      return {
        body,
        userInfo: parseUserInfo(response.headers.get("subscription-userinfo")),
        updateIntervalHours: parseUpdateIntervalHours(response.headers.get("profile-update-interval")),
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Тело по потоку: лишнее не вычитывается, поток закрывается сразу по превышению. */
async function readLimited(response: Response, maxBytes: number, guarded: <T>(promise: Promise<T>) => Promise<T>): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SubscriptionFetchError("too_large");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await guarded(reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new SubscriptionFetchError("too_large");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof SubscriptionFetchError) throw error;
    throw new SubscriptionFetchError("network");
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}
