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
 */

const networksSchema = z.object({
  networks: z.array(z.object({ network: z.string(), keys: z.record(z.string(), z.string()) })),
});

export type AdNetworksResponse = z.infer<typeof networksSchema>;

/** Сети, чей SDK поднимается при запуске, и их публичные ключи. `request` подменяется в тестах. */
export function fetchAdNetworks(request: ApiRequest = apiRequest): Promise<ApiResult<AdNetworksResponse>> {
  return request("/api/v1/ads/networks", networksSchema, { method: "GET" });
}

let state: "idle" | "pending" | "done" = "idle";

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
  if (response.data.networks.length > 0) await adapter.prepareAds(response.data.networks);
}

/** Для тестов: следующий вызов снова спрашивает сервер. */
export function resetAdNetworks(): void {
  state = "idle";
}
