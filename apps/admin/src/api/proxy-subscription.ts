import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Подписки Xray для прокси (`/admin/proxy-subscriptions`, docs/35-stage4-plan.md
 * Р101, Р192, tasks/T-0093, tasks/T-0384): подписок до десяти, узлы всех
 * включённых работают общим запасом прокси для исходящих запросов сервера.
 * Адрес подписки секретный: сервер его не отдаёт никогда — только подсказку
 * «хост …abcd»; панель шлёт адрес лишь тогда, когда его ввели. Действия идут по
 * ключу подписки: его выдаёт сервер при создании.
 */

const ROOT = "/proxy-subscriptions";

export const NODE_STATES = ["unknown", "healthy", "down"] as const;
export type NodeState = (typeof NODE_STATES)[number];

const nodeSchema = z.object({
  nodeKey: z.string(),
  name: z.string(),
  protocol: z.string(),
  country: z.string().nullable(),
  host: z.string(),
  state: z.enum(NODE_STATES),
  latencyMs: z.number().nullable(),
});
export type SubscriptionNode = z.infer<typeof nodeSchema>;

const subscriptionSchema = z.object({
  /** по ключу идут все действия; неизменен с рождения */
  key: z.string(),
  name: z.string(),
  /** «хост …abcd» — сверить с кабинетом поставщика */
  urlHint: z.string(),
  enabled: z.boolean(),
  countries: z.array(z.string()),
  lastRefreshAt: z.string().nullable(),
  lastRefreshOk: z.boolean().nullable(),
  lastRefreshNote: z.string().nullable(),
  trafficUsedBytes: z.number().nullable(),
  trafficTotalBytes: z.number().nullable(),
  expiresAt: z.string().nullable(),
  updatedAt: z.string(),
  nodes: z.array(nodeSchema),
});
export type SubscriptionInfo = z.infer<typeof subscriptionSchema>;

const overviewSchema = z.object({
  /** можно ли сохранить адрес: на сервере есть ключ шифрования */
  encryption: z.boolean(),
  /** контейнер Xray подключён: есть куда писать конфиг */
  sidecar: z.object({ connected: z.boolean() }),
  /** сколько подписок можно подключить */
  limit: z.number(),
  /** входов Xray всего */
  slotCount: z.number(),
  /** доля входов одной подписки сейчас */
  slotQuota: z.number(),
  /** по времени подключения */
  subscriptions: z.array(subscriptionSchema),
});
export type SubscriptionOverview = z.infer<typeof overviewSchema>;

/** Форма подписки как её вводит человек: страны — текстом через запятую. */
export interface SubscriptionForm {
  name: string;
  /** при правке пусто — прежний адрес остаётся */
  url: string;
  countries: string;
  enabled: boolean;
}

export const EMPTY_SUBSCRIPTION_FORM: SubscriptionForm = { name: "", url: "", countries: "", enabled: true };

/** Коды стран из текста: через запятую, пробел или точку с запятой; заглавными, без пустых. */
export function countriesOf(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== "");
}

const pathOf = (key: string, action = ""): string => `${ROOT}/${encodeURIComponent(key)}${action}`;

export function fetchSubscriptions(api: AdminApi): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(ROOT, { schema: overviewSchema });
}

/** Тело записи: строки обрезаны; адрес — только если введён, иначе сервер оставит прежний. */
function bodyOf(form: SubscriptionForm): Record<string, unknown> {
  const url = form.url.trim();
  const body: Record<string, unknown> = { name: form.name.trim(), countries: countriesOf(form.countries), enabled: form.enabled };
  if (url !== "") body.url = url;
  return body;
}

export function createSubscription(api: AdminApi, form: SubscriptionForm): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(ROOT, { method: "POST", body: bodyOf(form), schema: overviewSchema });
}

export function updateSubscription(api: AdminApi, key: string, form: SubscriptionForm): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(pathOf(key), { method: "PUT", body: bodyOf(form), schema: overviewSchema });
}

/** «Обновить сейчас»: сервер ходит к поставщику, это до пятнадцати секунд. */
export function refreshSubscription(api: AdminApi, key: string): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(pathOf(key, "/refresh"), { method: "POST", schema: overviewSchema, timeoutMs: 30_000 });
}

/** «Проверить узлы»: узлы подписки встают в очередь проверок, их разберёт расписание. */
export function probeSubscription(api: AdminApi, key: string): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(pathOf(key, "/probe"), { method: "POST", schema: overviewSchema });
}

export function deleteSubscription(api: AdminApi, key: string): Promise<ApiResult<{ removed: true }>> {
  return api.request(pathOf(key), { method: "DELETE", schema: z.object({ removed: z.literal(true) }) });
}
