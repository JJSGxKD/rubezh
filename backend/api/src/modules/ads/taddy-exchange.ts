import { Logger } from "@nestjs/common";
import { z } from "zod";
import { TADDY_API_URL, TADDY_EVENT_TIMEOUT_MS, httpsUrl, isTimeout, postTaddy, type TaddyUser } from "./taddy-api.js";

/**
 * Лента обмена трафиком Taddy (docs/35-stage4-plan.md WP13, часть 6, Р80):
 * задания «запусти бота», «открой приложение», «перейди по ссылке» других
 * участников обмена. Taddy за них не платит — выполнение приводит в игру
 * игроков из сети обмена, а проверяет его сама Taddy (`exchange/check`).
 *
 * Контракт сверен с SDK Taddy (`taddy-sdk-web` 1.2.12 и типы 1.3.17,
 * `Exchange`): лента — `exchange/feed`, показы — `exchange/impressions` со
 * списком идентификаторов, проверка — `exchange/check` с `taskId`; ответ —
 * `{ result, error }`. Ссылка задания — адрес самой Taddy: SDK шлёт на него
 * POST и открывает адрес из ответа. Её открывает клиент игрока, а не наш
 * сервер: переход Taddy считает по адресу и браузеру игрока, а запросы с
 * одного адреса сервера за всех игроков выглядели бы накруткой.
 */

/** Ленту ждёт строка задания, а не игрок у кнопки: она появится, когда придёт. */
export const TADDY_FEED_TIMEOUT_MS = 4_000;
/** Проверку ждёт игрок, нажавший «Проверить». */
export const TADDY_CHECK_TIMEOUT_MS = 5_000;
/**
 * Сколько заданий просить у ленты. Игроку показываем одно, но часть может
 * не подойти — без ссылки, уже выполненная у нас; запас — чтобы было из чего
 * выбрать без второго запроса. И чтобы задание, по которому игрок уже
 * перешёл, не выпало из ленты из-за порядка: пропавшее задание сервер
 * считает выполненным или снятым и, если Taddy не видит выполнения,
 * закрывает сессию.
 */
export const TADDY_FEED_LIMIT = 20;

export const TADDY_TASK_TYPES = ["bot", "app", "link"] as const;
export type TaddyTaskType = (typeof TADDY_TASK_TYPES)[number];

/** Задание ленты — уже проверенное: адреса только https, пустые строки — `null`. */
export interface TaddyExchangeTask {
  /** идентификатор задания у Taddy — по нему проверка и показ */
  id: string;
  title: string;
  description: string | null;
  /** квадратная картинка задания */
  image: string | null;
  /** что сделать: запустить бота, открыть приложение, перейти по ссылке; незнакомый вид — ссылка */
  type: TaddyTaskType;
  /** адрес Taddy, который отдаёт адрес перехода, — POST, как в SDK */
  link: string;
  /** игрок уже переходил, Taddy ждёт выполнения */
  pending: boolean;
}

/** Ответа нет: `invalid` — он не по контракту; `timeout` и `api_error` — сеть не ответила или ответила ошибкой. */
export interface TaddyFailure {
  kind: "none";
  reason: "invalid" | "timeout" | "api_error";
}

export type TaddyFeedResult = { kind: "feed"; tasks: TaddyExchangeTask[] } | TaddyFailure;

/** Ответ проверки: `done` — Taddy видит выполнение. Без ответа награды нет — игрок проверит ещё раз. */
export type TaddyCheckResult = { kind: "checked"; done: boolean } | TaddyFailure;

/** Игрок — тот же, что для креатива (`TaddyUser`): ленту Taddy подбирает по гео и языку. */
export interface TaddyExchangeApi {
  /** Лента для игрока — без выполненных и без автоматических показов: показ сервер отмечает сам, когда задание на экране. */
  feed(pubId: string, user: TaddyUser): Promise<TaddyFeedResult>;
  /** Задание ленты на экране игрока — Taddy считает показ. */
  impression(pubId: string, user: TaddyUser, taskId: string): Promise<void>;
  /** Выполнил ли игрок задание — по данным Taddy. */
  check(pubId: string, user: TaddyUser, taskId: string): Promise<TaddyCheckResult>;
}

export const TADDY_EXCHANGE = Symbol("TADDY_EXCHANGE");

const TEXT_MAX = { title: 200, description: 500 } as const;

const feedItemSchema = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).transform(String),
  title: z.string().nullish(),
  description: z.string().nullish(),
  image: z.string().nullish(),
  type: z.string().nullish(),
  link: z.string().nullish(),
  status: z.string().nullish(),
});

const feedSchema = z.object({ result: z.array(z.unknown()).max(100).nullish(), error: z.string().nullish() });
const checkSchema = z.object({ result: z.boolean().nullish(), error: z.string().nullish() });

function clip(value: string | null | undefined, max: number): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text.slice(0, max);
}

function failed(error: string | null | undefined): boolean {
  return error !== null && error !== undefined && error !== "";
}

/**
 * Задание из ответа или `null`, если показать его нельзя. Отбрасывается
 * задание без заголовка и без https-ссылки и выполненное: лента без
 * выполненных их и так не отдаёт, но если отдала — награды за них нет.
 */
export function exchangeTaskOf(raw: unknown): TaddyExchangeTask | null {
  const parsed = feedItemSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status === "completed") return null;
  const item = parsed.data;
  const title = clip(item.title, TEXT_MAX.title);
  const link = httpsUrl(item.link);
  if (title === null || link === null) return null;
  const type = TADDY_TASK_TYPES.find((known) => known === item.type) ?? "link";
  return { id: item.id, title, description: clip(item.description, TEXT_MAX.description), image: httpsUrl(item.image), type, link, pending: item.status === "pending" };
}

/** Лента из ответа: негодные задания отбрасываются по одному, а не всей лентой. */
export function feedOf(raw: unknown): TaddyFeedResult {
  const parsed = feedSchema.safeParse(raw);
  if (!parsed.success) return { kind: "none", reason: "invalid" };
  if (failed(parsed.data.error)) return { kind: "none", reason: "api_error" };
  const tasks = (parsed.data.result ?? []).map(exchangeTaskOf).filter((task) => task !== null);
  return { kind: "feed", tasks };
}

/** Ответ проверки: только явное `true` — выполнено. */
export function checkOf(raw: unknown): TaddyCheckResult {
  const parsed = checkSchema.safeParse(raw);
  if (!parsed.success) return { kind: "none", reason: "invalid" };
  if (failed(parsed.data.error)) return { kind: "none", reason: "api_error" };
  if (parsed.data.result === null || parsed.data.result === undefined) return { kind: "none", reason: "invalid" };
  return { kind: "checked", done: parsed.data.result };
}

/**
 * Идентификатор для Taddy — тем же типом, каким он пришёл. В ленте он
 * бывает числом (`Identifier` у SDK — число или строка), а хранится у нас
 * строкой; число из цифр отдаём обратно числом, как его отдал бы SDK.
 */
export function wireId(id: string): string | number {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(id)) return id;
  const value = Number(id);
  return Number.isSafeInteger(value) ? value : id;
}

export class HttpTaddyExchange implements TaddyExchangeApi {
  private readonly logger = new Logger("ads");

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = TADDY_API_URL,
  ) {}

  async feed(pubId: string, user: TaddyUser): Promise<TaddyFeedResult> {
    const path = "/exchange/feed";
    const answer = await this.call(path, { pubId, user, origin: "server", limit: TADDY_FEED_LIMIT, imageFormat: "webp", autoImpressions: false, showCompleted: false }, TADDY_FEED_TIMEOUT_MS);
    if (answer.kind === "none") return answer;
    const result = feedOf(answer.body);
    if (result.kind === "none") this.warn("taddy_exchange_failed", { path, reason: result.reason });
    return result;
  }

  async impression(pubId: string, user: TaddyUser, taskId: string): Promise<void> {
    // Показ уже был — несчитанный игроку ничего не стоит; отказ остаётся строкой в логе.
    await this.call("/exchange/impressions", { pubId, user, origin: "server", ids: [wireId(taskId)] }, TADDY_EVENT_TIMEOUT_MS);
  }

  async check(pubId: string, user: TaddyUser, taskId: string): Promise<TaddyCheckResult> {
    const path = "/exchange/check";
    const answer = await this.call(path, { pubId, user, origin: "server", taskId: wireId(taskId) }, TADDY_CHECK_TIMEOUT_MS);
    if (answer.kind === "none") return answer;
    const result = checkOf(answer.body);
    if (result.kind === "none") this.warn("taddy_exchange_failed", { path, reason: result.reason });
    return result;
  }

  /** Тело ответа или причина отказа — без исключений: отказ сети не роняет экран заданий. */
  private async call(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<{ kind: "body"; body: unknown } | TaddyFailure> {
    try {
      const response = await postTaddy(this.fetchImpl, `${this.baseUrl}${path}`, body, timeoutMs);
      if (!response.ok) {
        this.warn("taddy_exchange_failed", { path, status: response.status });
        return { kind: "none", reason: "api_error" };
      }
      return { kind: "body", body: await response.json() };
    } catch (error: unknown) {
      const reason = isTimeout(error) ? "timeout" : "api_error";
      this.warn("taddy_exchange_failed", { path, reason });
      return { kind: "none", reason };
    }
  }

  /** В лог — путь и код, без игрока: адрес и браузер — личные данные (docs/15-engineering-standards.md §7). */
  private warn(event: string, fields: Record<string, unknown>): void {
    this.logger.warn(JSON.stringify({ module: "ads", event, ...fields }));
  }
}
