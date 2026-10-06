import { z } from "zod/mini";
import { apiRequest, type ApiFailure, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";
import { useWallet } from "./wallet";

/**
 * Кошелёк игрока с сервера (docs/35-stage4-plan.md, WP3): монеты и
 * самоцветы в шапке. Клиент кошелёк только показывает — начисляет сервер за
 * забеги, задания и покупки, а счёт на устройстве был бы заявлением, а не
 * фактом.
 *
 * Сборка без авторизации (MAX, VK, тесты) не спрашивает ничего: там в шапке
 * нули, как было до экономики.
 *
 * Запрос и схема — отдельным чанком: шапка читает состояние (`wallet.ts`) с
 * первой загрузки, а спрашивать сервер нужно после неё
 * (docs/27-design-system-and-app-shell.md §3.4).
 */

// Осколки и новые ресурсы сервер добавит в тот же ответ — схема их
// пропускает, а не падает: клиент мог не обновиться.
const walletSchema = z.object({ balances: z.catchall(z.object({ coins: z.number(), gems: z.number() }), z.unknown()) });

/** Осколки — ключи `shard_<редкость>`; незнакомые ресурсы пропускаются. */
function shardsOf(balances: Record<string, unknown>): Partial<Record<string, number>> {
  const shards: Partial<Record<string, number>> = {};
  for (const [key, value] of Object.entries(balances)) {
    if (key.startsWith("shard_") && typeof value === "number") shards[key.slice("shard_".length)] = value;
  }
  return shards;
}

export interface WalletApi {
  balances(): Promise<ApiResult<z.infer<typeof walletSchema>>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createWalletApi(request: ApiRequest = apiRequest): WalletApi {
  return { balances: () => request("/api/v1/wallet", walletSchema, { method: "GET" }) };
}

export async function loadWallet(api?: WalletApi): Promise<ApiFailure | null> {
  if (api === undefined && useShell.getState().capabilities.auth === undefined) return "disabled";
  const response = await (api ?? createWalletApi()).balances();
  if (!response.ok) return response.failure;
  const balances = response.data.balances;
  useWallet.setState({ balances: { coins: balances.coins, gems: balances.gems, shards: shardsOf(balances) } });
  return null;
}
