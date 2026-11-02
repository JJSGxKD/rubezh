import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Подписка Xray для прокси (`/admin/proxy-subscription`, docs/35-stage4-plan.md
 * Р101, tasks/T-0093): одна подписка на систему, её узлы работают как прокси
 * для исходящих запросов сервера. Адрес подписки секретный: сервер его не
 * отдаёт никогда — только подсказку «хост …abcd»; панель шлёт адрес лишь тогда,
 * когда его ввели.
 */

const ROOT = "/proxy-subscription";

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
});
export type SubscriptionInfo = z.infer<typeof subscriptionSchema>;

const overviewSchema = z.object({
  /** можно ли сохранить адрес: на сервере есть ключ шифрования */
  encryption: z.boolean(),
  /** контейнер Xray подключён: есть куда писать конфиг */
  sidecar: z.object({ connected: z.boolean() }),
  subscription: subscriptionSchema.nullable(),
  nodes: z.array(nodeSchema),
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

export function fetchSubscription(api: AdminApi): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(ROOT, { schema: overviewSchema });
}

/** Тело записи: строки обрезаны; адрес — только если введён, иначе сервер оставит прежний. */
export function saveSubscription(api: AdminApi, form: SubscriptionForm): Promise<ApiResult<SubscriptionOverview>> {
  const url = form.url.trim();
  const body: Record<string, unknown> = { name: form.name.trim(), countries: countriesOf(form.countries), enabled: form.enabled };
  if (url !== "") body.url = url;
  return api.request(ROOT, { method: "PUT", body, schema: overviewSchema });
}

/** «Обновить сейчас»: сервер ходит к поставщику, это до пятнадцати секунд. */
export function refreshSubscription(api: AdminApi): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(`${ROOT}/refresh`, { method: "POST", schema: overviewSchema, timeoutMs: 30_000 });
}

/** «Проверить узлы»: узлы встают в очередь проверок, их разберёт расписание. */
export function probeSubscription(api: AdminApi): Promise<ApiResult<SubscriptionOverview>> {
  return api.request(`${ROOT}/probe`, { method: "POST", schema: overviewSchema });
}

export function deleteSubscription(api: AdminApi): Promise<ApiResult<{ removed: true }>> {
  return api.request(ROOT, { method: "DELETE", schema: z.object({ removed: z.literal(true) }) });
}
