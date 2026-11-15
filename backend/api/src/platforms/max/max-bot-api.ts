import { Logger } from "@nestjs/common";
import { z } from "zod";
import { MembershipRejectedError, MembershipUnavailableError } from "../ports/channel-membership.js";

/**
 * Клиент Bot API MAX (docs/35-stage4-plan.md Р188, tasks/T-0379): проверить
 * ключ бота, поставить и прочитать подписку вебхука, написать игроку и
 * спросить, состоит ли он в канале. Сверено с dev.max.ru/docs-api на 12.11.2026.
 *
 * - **Адрес** — `platform-api2.max.ru`: документация переводит ботов и мини-
 *   приложения на него со старого `platform-api.max.ru`.
 * - **Ключ** — голой строкой в заголовке `Authorization`, без «Bearer»; в
 *   адресе его нет (ключ в параметре запроса MAX больше не принимает), а в
 *   логах и сообщениях об ошибках — тем более. Читается при каждом запросе:
 *   замена ключа в панели действует без перезапуска.
 * - **Запросы идут через клиент исходящих** (`forService("max.bot")`, Р91):
 *   журнал, прокси и режим сервиса — оттуда. Потолок запроса — 5 секунд.
 * - **Ответы — граница системы**: разбираются схемой, а не приводятся.
 *
 * Ошибки двух видов (`MaxApiError.retryable`): повтор может помочь — сеть,
 * таймаут, 429, 5xx, ответ не по схеме; не поможет — ключ, права, канала нет.
 * Проверка подписки превращает их в `MembershipUnavailableError` и
 * `MembershipRejectedError` порта.
 */

export const MAX_API_BASE = "https://platform-api2.max.ru";

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Коды HTTP, которыми MAX отвечает на запросы бота (dev.max.ru/docs-api):
 * - 400 — запрос не принят (ошибка нашего запроса);
 * - 401 — ключ неверный или отключён;
 * - 403 — у бота нет доступа к ресурсу: для участников канала это «бот не
 *   администратор»;
 * - 404 — канала или чата нет;
 * - 429 — больше 30 запросов в секунду;
 * - 5xx — сбой MAX.
 * Повтор может помочь только при 408, 429 и 5xx; остальное — настройка.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** id чата или канала в MAX — целое, у каналов бывает отрицательным. */
const CHAT_ID = /^-?\d{1,19}$/;
/** id пользователя в MAX — целое без знака. */
const USER_ID = /^\d{1,19}$/;

/** Ответ MAX не получился: что вызывали, какой статус и код отказа; ни ключа, ни адреса с ним. */
export class MaxApiError extends Error {
  override readonly name = "MaxApiError";

  constructor(
    /** метод без подставленных id: `GET /chats/:id/members` */
    readonly method: string,
    /** HTTP-статус; `null` — ответа не было (сеть, таймаут, нет ключа) */
    readonly status: number | null,
    /** `code` из тела отказа MAX или наша метка: `timeout`, `network`, `bad_response`, `not_configured` */
    readonly code: string | null,
    readonly retryable: boolean,
  ) {
    super(`MAX ${method}: ${status === null ? "нет ответа" : String(status)}${code === null ? "" : ` ${code}`}`);
  }
}

/** Кнопка-ссылка под сообщением. */
export interface MaxLinkButton {
  text: string;
  url: string;
}

/** Подписка вебхука: адрес и типы событий; `null` — подписка на все. */
export interface MaxSubscription {
  url: string;
  updateTypes: readonly string[] | null;
}

const failureSchema = z.object({ code: z.string().max(128).nullish() });

const meSchema = z.object({ user_id: z.number().int(), username: z.string().nullish() });

const subscriptionsSchema = z.object({
  subscriptions: z.array(z.object({ url: z.string(), update_types: z.array(z.string()).nullish() })),
});

/** Результат методов подписки: бывает `200` с `success: false`. */
const resultSchema = z.object({ success: z.boolean(), code: z.string().max(128).nullish() });

const membersSchema = z.object({ members: z.array(z.object({ user_id: z.number().int() })) });

interface Call {
  method: "GET" | "POST";
  path: string;
  /** подпись для ошибок и лога — путь без подставленных id */
  label: string;
  query?: Record<string, string>;
  body?: unknown;
}

export class MaxBotApi {
  private readonly logger = new Logger("max");

  /**
   * @param tokenOf ключ бота на сейчас: из панели, потом окружение; `null` — не задан
   * @param fetchImpl `fetch` клиента исходящих с меткой `max.bot`
   */
  constructor(
    private readonly tokenOf: () => string | null,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Бот по ключу — проверка, что ключ рабочий. */
  async me(): Promise<{ userId: number; username: string | null }> {
    const bot = await this.request({ method: "GET", path: "/me", label: "GET /me" }, meSchema);
    return { userId: bot.user_id, username: bot.username ?? null };
  }

  async subscriptions(): Promise<MaxSubscription[]> {
    const list = await this.request({ method: "GET", path: "/subscriptions", label: "GET /subscriptions" }, subscriptionsSchema);
    return list.subscriptions.map((item) => ({ url: item.url, updateTypes: item.update_types ?? null }));
  }

  /** Подписать бота на события: MAX будет слать их на `url` с `secret` в заголовке `X-Max-Bot-Api-Secret`. */
  async subscribe(url: string, secret: string, updateTypes: readonly string[]): Promise<void> {
    const result = await this.request({ method: "POST", path: "/subscriptions", label: "POST /subscriptions", body: { url, update_types: updateTypes, secret } }, resultSchema);
    // MAX отвечает 200 и при отказе: исход — в `success`.
    if (!result.success) throw this.fail("POST /subscriptions", 200, result.code ?? null, false);
  }

  /** Личное сообщение игроку; кнопки-ссылки — каждая в своей строке. */
  async sendMessage(userId: string, text: string, buttons: readonly MaxLinkButton[] = []): Promise<void> {
    const attachments =
      buttons.length === 0 ? undefined : [{ type: "inline_keyboard", payload: { buttons: buttons.map((button) => [{ type: "link", text: button.text, url: button.url }]) } }];
    await this.request({ method: "POST", path: "/messages", label: "POST /messages", query: { user_id: userId }, body: { text, ...(attachments === undefined ? {} : { attachments }) } }, z.unknown());
  }

  /**
   * Состоит ли игрок в канале (`GET /chats/{chatId}/members?user_ids=…`): бот —
   * администратор канала, ответ без игрока — не состоит.
   *
   * @throws MembershipUnavailableError сеть, таймаут, 429, 5xx, ответ не по схеме, нет ключа
   * @throws MembershipRejectedError канал не числом, нет канала, бот не администратор, неверный ключ
   */
  async isChannelMember(chatId: string, userId: string): Promise<boolean> {
    if (!CHAT_ID.test(chatId)) throw new MembershipRejectedError("канал MAX в задании — число, id чата");
    // Аккаунт разработчика (`dev-…`) в MAX не существует — ни в каком канале его нет.
    if (!USER_ID.test(userId)) return false;
    try {
      const answer = await this.request(
        { method: "GET", path: `/chats/${chatId}/members`, label: "GET /chats/:id/members", query: { user_ids: userId } },
        membersSchema,
      );
      return answer.members.some((member) => member.user_id === Number(userId));
    } catch (error: unknown) {
      if (!(error instanceof MaxApiError)) throw error;
      throw error.retryable ? new MembershipUnavailableError(error.message) : new MembershipRejectedError(error.message);
    }
  }

  private async request<T>(call: Call, schema: z.ZodType<T>): Promise<T> {
    const token = this.tokenOf();
    if (token === null) throw this.fail(call.label, null, "not_configured", true);
    const url = new URL(call.path, MAX_API_BASE);
    for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, value);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: call.method,
        headers: { authorization: token, accept: "application/json", ...(call.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw this.fail(call.label, null, timeout ? "timeout" : "network", true);
    }

    if (!response.ok) throw this.fail(call.label, response.status, await this.failureCode(response), isRetryableStatus(response.status));
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw this.fail(call.label, response.status, "bad_response", true);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw this.fail(call.label, response.status, "bad_response", true);
    return parsed.data;
  }

  /** `code` из тела отказа; тело не по форме — без кода. */
  private async failureCode(response: Response): Promise<string | null> {
    try {
      const body = failureSchema.safeParse(await response.json());
      return body.success ? (body.data.code ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Ошибка и строка лога: метод, статус, код — и ничего, что вело бы к ключу. */
  private fail(method: string, status: number | null, code: string | null, retryable: boolean): MaxApiError {
    // Бот не настроен — штатное состояние, а не сбой: в лог оно не идёт.
    if (code !== "not_configured") this.logger.warn(JSON.stringify({ module: "max", event: "max_api_failed", method, status, code, retryable }));
    return new MaxApiError(method, status, code, retryable);
  }
}
