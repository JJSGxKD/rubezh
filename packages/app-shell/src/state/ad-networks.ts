import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * SDK рекламных сетей для учёта аудитории (docs/35-stage4-plan.md WP12,
 * часть 9, Р78): сеть видит игрока, только когда у него поднят её SDK, — у
 * всех игроков, а не у тех, кому уже показывали рекламу. Какие сети и с
 * какими ключами — решает сервер.
 *
 * Зовётся в простое главной вместе с предзагрузкой движка: чужой скрипт
 * первую загрузку не задерживает. Однажды за запуск; не вышло — попробует
 * следующий заход на главную. Свой запрос, а не клиент выдачи показа: тот
 * едет с местами рекламы, и общий модуль стал бы лишним чанком у обоих.
 *
 * Тот же ответ говорит, ждать ли игроку межстраничную при старте забега
 * (WP12, часть 10): вне доли выката её не спрашивают вовсе.
 */

const networksSchema = z.object({
  networks: z.array(z.object({ network: z.string(), keys: z.record(z.string(), z.string()) })),
  /** ждать ли межстраничную; сервер до неё поля не отдавал */
  interstitial: z.optional(z.boolean()),
});

export type AdNetworksResponse = z.infer<typeof networksSchema>;

/** Сети, чей SDK поднимается при запуске, и их публичные ключи. `request` подменяется в тестах. */
export function fetchAdNetworks(request: ApiRequest = apiRequest): Promise<ApiResult<AdNetworksResponse>> {
  return request("/api/v1/ads/networks", networksSchema, { method: "GET" });
}

let state: "idle" | "pending" | "done" = "idle";
let interstitial: boolean | null = null;

/**
 * Ждать ли межстраничную при старте забега: `false` — игрок вне доли выката
 * или площадка её не показывает, старт не спрашивает сервер; `null` — ещё не
 * знаем, спросим при старте. Решает всё равно выдача.
 */
export function interstitialExpected(): boolean | null {
  return interstitial;
}

export async function prepareAdNetworks(fetchNetworks: () => Promise<ApiResult<AdNetworksResponse>> = fetchAdNetworks): Promise<void> {
  const { adapter, capabilities } = useShell.getState();
  if (state !== "idle" || adapter.prepareAds === undefined || capabilities.auth === undefined || !capabilities.platformAvailable) return;
  state = "pending";
  const response = await fetchNetworks();
  if (!response.ok) {
    state = "idle";
    return;
  }
  state = "done";
  interstitial = response.data.interstitial ?? null;
  if (response.data.networks.length > 0) await adapter.prepareAds(response.data.networks);
}

/** Для тестов: следующий вызов снова спрашивает сервер. */
export function resetAdNetworks(): void {
  state = "idle";
  interstitial = null;
}
