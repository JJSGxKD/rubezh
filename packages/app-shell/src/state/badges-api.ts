import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useBadges, type Badges } from "./badges";
import { useShell } from "./shell";

/**
 * Знаки меню с сервера одним ответом (docs/35-stage4-plan.md Р50, §3.17):
 * состояние меняется и с другого устройства, поэтому считает сервер. Клиент
 * спрашивает при входе, на возврате в приложение, после забега и после
 * действий, которые гасят знак, — без постоянного соединения.
 */

// `daily`, `wheel` и `tasks` — с наградой дня, колесом и заданиями (WP13),
// `changelog` — с журналом обновлений (WP31): сервер старее клиента их не
// пришлёт, и знак просто не горит.
const badgesSchema = z.object({
  arsenal: z.number(),
  friends: z.number(),
  notifications: z.number(),
  daily: z.optional(z.number()),
  changelog: z.optional(z.number()),
  wheel: z.optional(z.number()),
  tasks: z.optional(z.number()),
});

type BadgesResponse = z.infer<typeof badgesSchema>;

export interface BadgesApi {
  badges(): Promise<ApiResult<BadgesResponse>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createBadgesApi(request: ApiRequest = apiRequest): BadgesApi {
  return { badges: () => request("/api/v1/me/badges", badgesSchema, { method: "GET" }) };
}

/** Не ответил сервер — знаки остаются прежними: пустые хуже устаревших. */
export async function loadBadges(api?: BadgesApi, now = Date.now()): Promise<void> {
  if (api === undefined && useShell.getState().capabilities.auth === undefined) return;
  const response = await (api ?? createBadgesApi()).badges();
  if (response.ok) {
    const { daily, changelog, wheel, tasks } = response.data;
    useBadges.setState({ ...response.data, daily: daily ?? 0, changelog: changelog ?? 0, wheel: wheel ?? 0, tasks: tasks ?? 0, loadedAt: now } satisfies Badges);
  }
}

let watching = false;

/**
 * Знаки — и на возврате в приложение: подарок друга, пришедший, пока игра
 * была свёрнута, виден без перезапуска.
 */
export function watchReturns(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadBadges();
  });
}
